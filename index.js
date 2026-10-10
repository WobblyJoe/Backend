
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
require("dotenv").config();

const app = express();

app.use(express.json());

app.use(cors({
  origin: [
    "http://localhost:5173",
    process.env.FRONTEND_URL
  ].filter(Boolean)
}));

const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: Number(process.env.TIDB_PORT || 4000),
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { minVersion: "TLSv1.2" },
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});

// Create tables automatically before handling API requests.
let initializationPromise;

async function initializeDatabase() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS grps (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS members (
          id INT AUTO_INCREMENT PRIMARY KEY,
          group_id INT NOT NULL,
          name VARCHAR(100) NOT NULL,
          FOREIGN KEY (group_id) REFERENCES grps(id)
            ON DELETE CASCADE
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS expenses (
          id INT AUTO_INCREMENT PRIMARY KEY,
          group_id INT NOT NULL,
          title VARCHAR(150) NOT NULL,
          amount BIGINT NOT NULL,
          category VARCHAR(60) NOT NULL,
          paid_by INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (group_id) REFERENCES grps(id)
            ON DELETE CASCADE,
          FOREIGN KEY (paid_by) REFERENCES members(id)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS splits (
          id INT AUTO_INCREMENT PRIMARY KEY,
          expense_id INT NOT NULL,
          member_id INT NOT NULL,
          amount BIGINT NOT NULL,
          FOREIGN KEY (expense_id) REFERENCES expenses(id)
            ON DELETE CASCADE,
          FOREIGN KEY (member_id) REFERENCES members(id)
        )
      `);
    })().catch(error => {
      initializationPromise = null;
      throw error;
    });
  }

  return initializationPromise;
}

app.use(async (req, res, next) => {
  try {
    await initializeDatabase();
    next();
  } catch (error) {
    console.error("Database initialization failed:", error.message);
    res.status(500).json({ error: "Database initialization failed." });
  }
});

function calculateSettlements(members, expenses, splits) {
  const balances = new Map(
    members.map(member => [member.id, 0])
  );

  for (const expense of expenses) {
    balances.set(
      expense.paid_by,
      (balances.get(expense.paid_by) || 0) + Number(expense.amount)
    );
  }

  for (const split of splits) {
    balances.set(
      split.member_id,
      (balances.get(split.member_id) || 0) - Number(split.amount)
    );
  }

  const debtors = [];
  const creditors = [];

  for (const member of members) {
    const balance = balances.get(member.id) || 0;

    if (balance < 0) {
      debtors.push({ id: member.id, name: member.name, amount: -balance });
    } else if (balance > 0) {
      creditors.push({ id: member.id, name: member.name, amount: balance });
    }
  }

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const settlements = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);

    if (amount > 0) {
      settlements.push({
        from: debtors[i].name,
        to: creditors[j].name,
        amount
      });
    }

    debtors[i].amount -= amount;
    creditors[j].amount -= amount;

    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }

  return { balances, settlements };
}

async function getGroupDetails(groupId) {
  const [[group]] = await pool.query(
    "SELECT * FROM grps WHERE id = ?", [groupId]
  );

  if (!group) return null;

  const [members] = await pool.query(
    "SELECT id, group_id, name FROM members WHERE group_id = ?",
    [groupId]
  );

  const [expenses] = await pool.query(
    "SELECT * FROM expenses WHERE group_id = ? ORDER BY id DESC",
    [groupId]
  );

  const expenseIds = expenses.map(expense => expense.id);
  let splits = [];

  if (expenseIds.length) {
    const placeholders = expenseIds.map(() => "?").join(",");
    [splits] = await pool.query(
      `SELECT * FROM splits WHERE expense_id IN (${placeholders})`,
      expenseIds
    );
  }

  const { balances, settlements } =
    calculateSettlements(members, expenses, splits);

  const memberBalances = members.map(member => ({
    ...member,
    balance: balances.get(member.id) || 0
  }));

  const categories = {};

  for (const expense of expenses) {
    categories[expense.category] =
      (categories[expense.category] || 0) + Number(expense.amount);
  }

  return {
    ...group,
    members: memberBalances,
    expenses,
    settlements,
    categories
  };
}

// Health check
app.get("/", (req, res) => {
  res.json({ message: "Expense Splitter API is running." });
});

// List groups
app.get("/api/groups", async (req, res, next) => {
  try {
    const [groups] = await pool.query(
      "SELECT * FROM grps ORDER BY id DESC"
    );

    const result = [];

    for (const group of groups) {
      result.push(await getGroupDetails(group.id));
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Create a group and its members
app.post("/api/groups", async (req, res, next) => {
  const name = String(req.body.name || "").trim();
  const members = Array.isArray(req.body.members)
    ? [...new Set(req.body.members.map(m => String(m).trim()).filter(Boolean))]
    : [];

  if (!name || members.length < 2) {
    return res.status(400).json({
      error: "A group name and at least two members are required."
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [groupResult] = await connection.query(
      "INSERT INTO grps (name) VALUES (?)", [name]
    );

    for (const memberName of members) {
      await connection.query(
        "INSERT INTO members (group_id, name) VALUES (?, ?)",
        [groupResult.insertId, memberName]
      );
    }

    await connection.commit();

    res.status(201).json(await getGroupDetails(groupResult.insertId));
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// Get one group
app.get("/api/groups/:id", async (req, res, next) => {
  try {
    const group = await getGroupDetails(Number(req.params.id));

    if (!group) return res.status(404).json({ error: "Group not found." });

    res.json(group);
  } catch (error) {
    next(error);
  }
});

// Add an equally split expense. Amount is in paise.
app.post("/api/groups/:id/expenses", async (req, res, next) => {
  const groupId = Number(req.params.id);
  const title = String(req.body.title || "").trim();
  const amount = Number(req.body.amount);
  const category = String(req.body.category || "Other").trim();
  const paidBy = Number(req.body.paidBy);
  const splitBetween = Array.isArray(req.body.splitBetween)
    ? [...new Set(req.body.splitBetween.map(Number))]
    : [];

  if (!title || !Number.isSafeInteger(amount) || amount <= 0 ||
      !category || !Number.isInteger(paidBy) || !splitBetween.length) {
    return res.status(400).json({ error: "Invalid expense details." });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [groupRows] = await connection.query(
      "SELECT id FROM grps WHERE id = ?", [groupId]
    );

    const [memberRows] = await connection.query(
      "SELECT id FROM members WHERE group_id = ?", [groupId]
    );

    const validMemberIds = new Set(memberRows.map(m => m.id));

    if (!groupRows.length || !validMemberIds.has(paidBy) ||
        splitBetween.some(id => !validMemberIds.has(id))) {
      await connection.rollback();
      return res.status(400).json({
        error: "Group, payer, or split members are invalid."
      });
    }

    const [expenseResult] = await connection.query(
      `INSERT INTO expenses (group_id, title, amount, category, paid_by)
       VALUES (?, ?, ?, ?, ?)`,
      [groupId, title, amount, category, paidBy]
    );

    // Divide paise exactly, distributing any remainder one paise at a time.
    const baseShare = Math.floor(amount / splitBetween.length);
    const remainder = amount % splitBetween.length;

    for (let i = 0; i < splitBetween.length; i++) {
      const share = baseShare + (i < remainder ? 1 : 0);

      await connection.query(
        "INSERT INTO splits (expense_id, member_id, amount) VALUES (?, ?, ?)",
        [expenseResult.insertId, splitBetween[i], share]
      );
    }

    await connection.commit();

    res.status(201).json(await getGroupDetails(groupId));
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// Delete an expense; its splits are removed by the foreign key.
app.delete("/api/groups/:id/expenses/:eid", async (req, res, next) => {
  try {
    const [result] = await pool.query(
      "DELETE FROM expenses WHERE id = ? AND group_id = ?",
      [Number(req.params.eid), Number(req.params.id)]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: "Expense not found." });
    }

    res.json(await getGroupDetails(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

// Central error handler
app.use((error, req, res, next) => {
  console.error(error.message);
  res.status(500).json({ error: "Internal server error." });
});

if (require.main === module) {
  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`API running at http://localhost:${port}`);
  });
}

module.exports = app;
