const axios = require("axios");
require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json());
app.use(cors());

const server = http.createServer(app);
const client = new MongoClient(process.env.DB_URL);

let usersCollection;
let ordersCollection;
let assignmentsCollection;
let remindersCollection;

// ================= DB CONNECT =================
async function start() {
  try {
    await client.connect();

    const db = client.db("order-management");

    usersCollection = db.collection("user");
    ordersCollection = db.collection("orders");
    assignmentsCollection = db.collection("assignments");
    remindersCollection = db.collection("reminders");

    console.log("DB Connected");

    server.listen(5000, () => {
      console.log("Server running on 5000");
    });
  } catch (err) {
    console.error("DB Error:", err);
  }
}
start();

// ================= SIGNUP (IMPORTANT) =================
app.post("/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    const exist = await usersCollection.findOne({ email });
    if (exist) return res.status(400).send("User already exists");

    const hash = await bcrypt.hash(password, 10);

    const user = {
      name,
      email,
      password: hash,
      role: role || "user",
      isApproved: false,
      createdAt: new Date(),
    };

    await usersCollection.insertOne(user);

    res.send({ message: "User created" });
  } catch (err) {
    res.status(500).send({ message: "Register error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await usersCollection.findOne({ email });

    if (!user) return res.status(404).send("User not found");

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).send("Invalid credentials");

    // 🔥 APPROVAL CHECK (ONLY FOR USER ROLE)
    if (user.role === "user") {
      if (!user.isApproved) {
        return res.status(403).send({
          message: "Admin approval required",
        });
      }

      // 🔥 RESET APPROVAL AFTER LOGIN (SAFE FIX)
      await usersCollection.updateOne(
        { _id: new ObjectId(user._id) },
        { $set: { isApproved: false } },
      );
    }

    res.send({
      message: "Login success",
      user: {
        ...user,
        password: undefined,
        isApproved: false,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Login error" });
  }
});

// ================= GET PENDING REQUESTS =================
app.get("/admin/requests", async (req, res) => {
  try {
    const users = await usersCollection
      .find({ role: "user", isApproved: false })
      .toArray();

    res.send(users);
  } catch (err) {
    res.status(500).send({ message: "Server error" });
  }
});

// ================= APPROVE =================
app.patch("/admin/approve/:id", async (req, res) => {
  try {
    await usersCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { isApproved: true } },
    );

    res.send({ message: "Approved successfully" });
  } catch (err) {
    res.status(500).send({ message: "Approval error" });
  }
});

// ================= REJECT =================
app.patch("/admin/reject/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid user id" });
    }

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isApproved: false } },
    );
    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send({ message: "Rejected successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Reject error" });
  }
});

app.post("/logout", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).send({ message: "userId missing" });
    }

    console.log("logout request userId:", userId);

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { isApproved: false } },
    );

    console.log("update result:", result);

    if (result.modifiedCount === 0) {
      return res.status(404).send({ message: "User not updated" });
    }

    res.send({ message: "Logout success & isApproved false" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Logout error" });
  }
});

// Order system
app.post("/orders", async (req, res) => {
  try {
    const { name, email, phone, address, details } = req.body;

    // validation
    if (!name || !email || !phone || !address || !details) {
      return res.status(400).send({ message: "All fields are required" });
    }

    const order = {
      name,
      email,
      phone,
      address,
      details,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await ordersCollection.insertOne(order);

    res.send({
      message: "Order created successfully",
      orderId: result.insertedId,
    });
  } catch (err) {
    res.status(500).send({ message: "Order creation failed" });
  }
});

// get all order
app.get("/orders", async (req, res) => {
  try {
    const orders = await ordersCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.send(orders);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch orders" });
  }
});

app.patch("/orders/:id", async (req, res) => {
  try {
    const { status } = req.body;

    const order = await ordersCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!order) {
      return res.status(404).send({ message: "Order not found" });
    }

    await ordersCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      },
    );

    res.send({ message: "Order updated" });

    // 🔥 background sync
    if (status === "Completed") {
      (async () => {
        try {
          const axios = require("axios");

          const payload = {
            name: order.name,
            email: order.email,
            phone: order.phone,
            address: order.address,
            details: order.details,
            status: "Completed",
          };

          console.log("📤 Sending to Google Sheet:");
          console.log(payload);

          const response = await axios.post(
            "https://script.google.com/macros/s/AKfycbyPYf5eQ8IPCyPMzoG586pGtLHuOzC2vR9KH6wD73u9E2Lca3Zg726oEQH1YY0zyzWi/exec",
            JSON.stringify(payload),
            {
              headers: {
                "Content-Type": "text/plain",
              },
            },
          );

          console.log("📥 Sheet Response:");
          console.log(response.data);

          console.log("✅ Sheet sync success");
        } catch (err) {
          console.error("❌ Sheet Error:", err.message);
        }
      })();
    }
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Error" });
  }
});

// Assigend order subadmin
app.post("/assign-orders", async (req, res) => {
  try {
    const { adminId, adminName, orders } = req.body;

    const assignment = {
      adminId, // ✅ save ID
      adminName, // optional name
      orders: orders.map((id) => new ObjectId(id)),
      status: "assigned",
      createdAt: new Date(),
    };

    await assignmentsCollection.insertOne(assignment);

    await ordersCollection.updateMany(
      { _id: { $in: assignment.orders } },
      {
        $set: {
          status: "Processing",
          assignedTo: adminId, // ✅ VERY IMPORTANT
        },
      },
    );

    res.send({ message: "Orders assigned successfully" });
  } catch (err) {
    res.status(500).send({ message: "Failed to assign" });
  }
});

app.get("/subadmin/orders/:subAdminId", async (req, res) => {
  try {
    const { subAdminId } = req.params;

    const orders = await ordersCollection
      .find({ assignedTo: subAdminId })
      .toArray();

    res.send(orders);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to fetch orders" });
  }
});

app.get("/assignments", async (req, res) => {
  try {
    const data = await assignmentsCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.send(data);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch assignments" });
  }
});

app.get("/assignments/:admin", async (req, res) => {
  try {
    const data = await assignmentsCollection
      .find({ admin: req.params.admin })
      .toArray();

    res.send(data);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch admin assignments" });
  }
});

app.get("/users", async (req, res) => {
  try {
    const users = await usersCollection
      .find({ role: "user" })
      .project({ password: 0 })
      .toArray();

    res.send(users);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch users" });
  }
});

app.post("/reminders", async (req, res) => {
  try {
    const { orderId, message, createdBy } = req.body;

    if (!orderId || !message) {
      return res.status(400).send({ message: "Missing fields" });
    }

    const reminder = {
      orderId,
      message,
      createdBy: createdBy || "Admin",
      createdAt: new Date(),
    };

    const result = await remindersCollection.insertOne(reminder);

    res.send({
      message: "Reminder created",
      id: result.insertedId,
      reminder,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to create reminder" });
  }
});

app.get("/reminders", async (req, res) => {
  try {
    const reminders = await remindersCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.send(reminders);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch reminders" });
  }
});
