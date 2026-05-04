// ============================================================
// MAYAR BILLING SYSTEM - Node.js / Express
// Integrasi lengkap: Invoice, Cek Status, Webhook + Mikrotik PPPoE
// ============================================================

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const mikrotik = require("./mikrotik");

const app = express();
app.use(express.json());

// ============================================================
// KONFIGURASI
// ============================================================
const CONFIG = {
  MAYAR_API_KEY: process.env.MAYAR_API_KEY || "YOUR_MAYAR_API_KEY",
  MAYAR_API_URL: "https://api.mayar.id/hl/v1",
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "YOUR_WEBHOOK_SECRET",
  PORT: process.env.PORT || 3000,
};

const mayarHeaders = () => ({
  Authorization: `Bearer ${CONFIG.MAYAR_API_KEY}`,
  "Content-Type": "application/json",
});

// ============================================================
// 1. BUAT TAGIHAN
// POST /billing/create
// Body: { name, email, phone, amount, description, dueDate, pppoeUsername }
// ============================================================
app.post("/billing/create", async (req, res) => {
  try {
    const { name, email, phone, amount, description, dueDate, pppoeUsername } = req.body;

    if (!name || !email || !amount || !description) {
      return res.status(400).json({
        success: false,
        message: "Field name, email, amount, description wajib diisi.",
      });
    }

    const payload = {
      name,
      email,
      mobile: phone || "",
      amount: parseInt(amount),
      description: pppoeUsername
        ? `${description} [pppoe:${pppoeUsername}]`
        : description,
      redirectUrl: "https://bilingkamu.com/terima-kasih",
      expiredDate: dueDate || null,
    };

    const response = await axios.post(
      `${CONFIG.MAYAR_API_URL}/payment/create`,
      payload,
      { headers: mayarHeaders() }
    );

    const data = response.data;

    return res.status(200).json({
      success: true,
      message: "Tagihan berhasil dibuat.",
      data: {
        invoiceId: data.data?.id,
        paymentLink: data.data?.link,
        status: data.data?.status,
        amount: data.data?.amount,
        pppoeUsername: pppoeUsername || null,
        customer: { name: data.data?.name, email: data.data?.email },
      },
    });
  } catch (error) {
    console.error("Error membuat tagihan:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal membuat tagihan.",
      error: error.response?.data || error.message,
    });
  }
});

// ============================================================
// 2. CEK STATUS PEMBAYARAN
// GET /billing/status/:invoiceId
// ============================================================
app.get("/billing/status/:invoiceId", async (req, res) => {
  try {
    const response = await axios.get(
      `${CONFIG.MAYAR_API_URL}/payment/${req.params.invoiceId}`,
      { headers: mayarHeaders() }
    );

    const data = response.data;
    const statusLabel = {
      paid: "LUNAS", unpaid: "BELUM BAYAR",
      expired: "KADALUARSA", cancelled: "DIBATALKAN",
    };

    return res.status(200).json({
      success: true,
      data: {
        invoiceId: data.data?.id,
        status: data.data?.status,
        statusLabel: statusLabel[data.data?.status] || data.data?.status,
        amount: data.data?.amount,
        paidAt: data.data?.paidAt || null,
        customer: { name: data.data?.name, email: data.data?.email },
        paymentLink: data.data?.link,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ============================================================
// 3. DAFTAR TAGIHAN
// GET /billing/list?page=1&pageSize=10&status=unpaid
// ============================================================
app.get("/billing/list", async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status } = req.query;
    let url = `${CONFIG.MAYAR_API_URL}/payment?page=${page}&pageSize=${pageSize}`;
    if (status) url += `&status=${status}`;

    const response = await axios.get(url, { headers: mayarHeaders() });
    const data = response.data;

    return res.status(200).json({
      success: true,
      total: data.data?.total || 0,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      data: data.data?.items || [],
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ============================================================
// 4. TAGIHAN MASSAL BULANAN
// POST /billing/bulk
// Body: { customers: [{name, email, phone, amount, description, pppoeUsername}] }
// ============================================================
app.post("/billing/bulk", async (req, res) => {
  try {
    const { customers } = req.body;

    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ success: false, message: "Field customers (array) wajib diisi." });
    }

    const results = [];

    for (const customer of customers) {
      try {
        const desc = customer.pppoeUsername
          ? `${customer.description || "Tagihan Internet Bulanan"} [pppoe:${customer.pppoeUsername}]`
          : customer.description || "Tagihan Internet Bulanan";

        const response = await axios.post(
          `${CONFIG.MAYAR_API_URL}/payment/create`,
          {
            name: customer.name,
            email: customer.email,
            mobile: customer.phone || "",
            amount: parseInt(customer.amount),
            description: desc,
            redirectUrl: "https://bilingkamu.com/terima-kasih",
          },
          { headers: mayarHeaders() }
        );

        results.push({
          customer: customer.name,
          email: customer.email,
          pppoeUsername: customer.pppoeUsername || null,
          status: "success",
          paymentLink: response.data?.data?.link,
          invoiceId: response.data?.data?.id,
        });

        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        results.push({
          customer: customer.name,
          email: customer.email,
          status: "failed",
          error: err.response?.data?.message || err.message,
        });
      }
    }

    return res.status(200).json({
      success: true,
      summary: {
        total: customers.length,
        berhasil: results.filter((r) => r.status === "success").length,
        gagal: results.filter((r) => r.status === "failed").length,
      },
      results,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 5. WEBHOOK - Notifikasi dari Mayar → Otomatis Mikrotik
// POST /billing/webhook
// ============================================================
app.post("/billing/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-mayar-signature"] || "";
    const rawBody = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac("sha256", CONFIG.WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.warn("Webhook signature tidak valid!");
      return res.status(401).json({ message: "Signature tidak valid." });
    }

    const event = req.body;
    const { id, name, email, amount, description } = event?.data || {};

    console.log(`\n[WEBHOOK] Event: ${event?.event} | ID: ${id} | ${name}`);

    // Ekstrak PPPoE username dari description
    // Format: "Tagihan Internet [pppoe:username_pelanggan]"
    const pppoeMatch = description?.match(/\[pppoe:([^\]]+)\]/);
    const pppoeUsername = pppoeMatch ? pppoeMatch[1] : null;

    switch (event?.event) {
      case "payment.success":
        await handlePaymentSuccess({ id, name, email, amount, description, pppoeUsername });
        break;
      case "payment.expired":
        await handlePaymentExpired({ id, name, email, pppoeUsername });
        break;
      default:
        console.log(`Event tidak dikenali: ${event?.event}`);
    }

    return res.status(200).json({ message: "Webhook diterima." });
  } catch (error) {
    console.error("Error webhook:", error.message);
    return res.status(500).json({ message: "Internal server error." });
  }
});

// ============================================================
// HANDLER: Bayar → Aktifkan PPPoE Mikrotik
// ============================================================
async function handlePaymentSuccess({ id, name, email, amount, pppoeUsername }) {
  console.log(`\n[BAYAR] ${name} (${email}) - Rp${Number(amount)?.toLocaleString("id-ID")}`);

  if (pppoeUsername) {
    console.log(`[MIKROTIK] Mengaktifkan user: ${pppoeUsername}`);
    const result = await mikrotik.enablePPPoEUser(pppoeUsername);
    console.log(`[MIKROTIK] ${result.success ? "Berhasil aktifkan" : "Gagal: " + result.error}`);
  }

  // TODO: db.query("UPDATE invoices SET status='paid' WHERE id=?", [id]);
}

// ============================================================
// HANDLER: Kadaluarsa → Suspend PPPoE Mikrotik
// ============================================================
async function handlePaymentExpired({ id, name, email, pppoeUsername }) {
  console.log(`\n[EXPIRED] ${name} (${email}) - Tagihan kadaluarsa`);

  if (pppoeUsername) {
    console.log(`[MIKROTIK] Mensuspend user: ${pppoeUsername}`);
    const result = await mikrotik.disablePPPoEUser(pppoeUsername);
    console.log(`[MIKROTIK] ${result.success ? "Berhasil suspend" : "Gagal: " + result.error}`);
  }

  // TODO: db.query("UPDATE invoices SET status='expired' WHERE id=?", [id]);
}

// ============================================================
// ENDPOINT MIKROTIK - Manajemen PPPoE Langsung
// ============================================================

// Test koneksi ke Mikrotik
app.get("/mikrotik/test", async (req, res) => {
  const result = await mikrotik.testConnection();
  return res.status(result.success ? 200 : 500).json(result);
});

// Daftar semua PPPoE user
app.get("/mikrotik/users", async (req, res) => {
  const result = await mikrotik.listPPPoEUsers();
  return res.status(result.success ? 200 : 500).json(result);
});

// Status PPPoE user tertentu
app.get("/mikrotik/users/:username", async (req, res) => {
  const result = await mikrotik.getPPPoEUserStatus(req.params.username);
  return res.status(result.success ? 200 : 404).json(result);
});

// Buat PPPoE user baru
app.post("/mikrotik/users", async (req, res) => {
  const { username, password, profile, comment } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "username dan password wajib diisi." });
  }
  const result = await mikrotik.createPPPoEUser({ username, password, profile, comment });
  return res.status(result.success ? 200 : 500).json(result);
});

// Aktifkan PPPoE user manual
app.post("/mikrotik/users/:username/enable", async (req, res) => {
  const result = await mikrotik.enablePPPoEUser(req.params.username);
  return res.status(result.success ? 200 : 500).json(result);
});

// Suspend PPPoE user manual
app.post("/mikrotik/users/:username/disable", async (req, res) => {
  const result = await mikrotik.disablePPPoEUser(req.params.username);
  return res.status(result.success ? 200 : 500).json(result);
});

// ============================================================
// JALANKAN SERVER
// ============================================================
app.listen(CONFIG.PORT, () => {
  console.log(`\n Mayar Billing + Mikrotik PPPoE | Port ${CONFIG.PORT}`);
  console.log(`\n Billing:`);
  console.log(`   POST  /billing/create`);
  console.log(`   GET   /billing/status/:id`);
  console.log(`   GET   /billing/list`);
  console.log(`   POST  /billing/bulk`);
  console.log(`   POST  /billing/webhook`);
  console.log(`\n Mikrotik PPPoE:`);
  console.log(`   GET   /mikrotik/test`);
  console.log(`   GET   /mikrotik/users`);
  console.log(`   GET   /mikrotik/users/:username`);
  console.log(`   POST  /mikrotik/users`);
  console.log(`   POST  /mikrotik/users/:username/enable`);
  console.log(`   POST  /mikrotik/users/:username/disable\n`);
});
