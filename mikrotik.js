// ============================================================
// mikrotik.js - Modul Integrasi Mikrotik PPPoE
// Menggunakan node-routeros (RouterOS API)
// ============================================================

const RouterOSAPI = require("node-routeros").RouterOSAPI;

const MIKROTIK = {
  HOST: process.env.MIKROTIK_HOST || "192.168.1.1",
  PORT: parseInt(process.env.MIKROTIK_PORT) || 8728, // 8728 = API, 8729 = API-SSL
  USER: process.env.MIKROTIK_USER || "admin",
  PASS: process.env.MIKROTIK_PASS || "",
  TIMEOUT: 10000,
};

// ============================================================
// Helper: Buat koneksi ke Mikrotik
// ============================================================
async function connectMikrotik() {
  const conn = new RouterOSAPI({
    host: MIKROTIK.HOST,
    port: MIKROTIK.PORT,
    user: MIKROTIK.USER,
    password: MIKROTIK.PASS,
    timeout: MIKROTIK.TIMEOUT,
  });

  await conn.connect();
  return conn;
}

// ============================================================
// 1. AKTIFKAN PPPoE User (enable)
// Dipanggil saat pelanggan BAYAR
// ============================================================
async function enablePPPoEUser(username) {
  let conn;
  try {
    conn = await connectMikrotik();

    // Cari user PPPoE berdasarkan username
    const users = await conn.write("/ppp/secret/print", [
      `?name=${username}`,
    ]);

    if (!users || users.length === 0) {
      throw new Error(`User PPPoE '${username}' tidak ditemukan di Mikrotik.`);
    }

    const userId = users[0][".id"];

    // Enable user (hapus flag disabled)
    await conn.write("/ppp/secret/enable", [`=.id=${userId}`]);

    // Jika user sedang aktif (online), kick dulu supaya reconnect fresh
    const activeSessions = await conn.write("/ppp/active/print", [
      `?name=${username}`,
    ]);

    if (activeSessions && activeSessions.length > 0) {
      const sessionId = activeSessions[0][".id"];
      await conn.write("/ppp/active/remove", [`=.id=${sessionId}`]);
      console.log(`   🔄 Session aktif ${username} di-refresh.`);
    }

    console.log(`   ✅ PPPoE user '${username}' berhasil DIAKTIFKAN.`);
    return { success: true, username, action: "enabled" };
  } catch (error) {
    console.error(`   ❌ Gagal aktifkan PPPoE user '${username}':`, error.message);
    return { success: false, username, error: error.message };
  } finally {
    if (conn) conn.close();
  }
}

// ============================================================
// 2. SUSPEND PPPoE User (disable)
// Dipanggil saat tagihan KADALUARSA / tidak bayar
// ============================================================
async function disablePPPoEUser(username) {
  let conn;
  try {
    conn = await connectMikrotik();

    // Cari user PPPoE
    const users = await conn.write("/ppp/secret/print", [
      `?name=${username}`,
    ]);

    if (!users || users.length === 0) {
      throw new Error(`User PPPoE '${username}' tidak ditemukan di Mikrotik.`);
    }

    const userId = users[0][".id"];

    // Disable user
    await conn.write("/ppp/secret/disable", [`=.id=${userId}`]);

    // Putuskan sesi aktif jika sedang online
    const activeSessions = await conn.write("/ppp/active/print", [
      `?name=${username}`,
    ]);

    if (activeSessions && activeSessions.length > 0) {
      const sessionId = activeSessions[0][".id"];
      await conn.write("/ppp/active/remove", [`=.id=${sessionId}`]);
      console.log(`   🔌 Sesi aktif ${username} diputus.`);
    }

    console.log(`   🚫 PPPoE user '${username}' berhasil DISUSPEND.`);
    return { success: true, username, action: "disabled" };
  } catch (error) {
    console.error(`   ❌ Gagal suspend PPPoE user '${username}':`, error.message);
    return { success: false, username, error: error.message };
  } finally {
    if (conn) conn.close();
  }
}

// ============================================================
// 3. BUAT PPPoE User BARU
// Dipanggil saat pelanggan baru didaftarkan
// ============================================================
async function createPPPoEUser({ username, password, profile = "default", comment = "" }) {
  let conn;
  try {
    conn = await connectMikrotik();

    // Cek apakah user sudah ada
    const existing = await conn.write("/ppp/secret/print", [
      `?name=${username}`,
    ]);

    if (existing && existing.length > 0) {
      throw new Error(`User PPPoE '${username}' sudah ada.`);
    }

    // Buat user baru
    await conn.write("/ppp/secret/add", [
      `=name=${username}`,
      `=password=${password}`,
      `=service=pppoe`,
      `=profile=${profile}`,
      `=comment=${comment}`,
    ]);

    console.log(`   ➕ PPPoE user '${username}' berhasil DIBUAT.`);
    return { success: true, username, action: "created" };
  } catch (error) {
    console.error(`   ❌ Gagal buat PPPoE user '${username}':`, error.message);
    return { success: false, username, error: error.message };
  } finally {
    if (conn) conn.close();
  }
}

// ============================================================
// 4. CEK STATUS PPPoE User
// ============================================================
async function getPPPoEUserStatus(username) {
  let conn;
  try {
    conn = await connectMikrotik();

    // Data user dari secrets
    const users = await conn.write("/ppp/secret/print", [
      `?name=${username}`,
    ]);

    if (!users || users.length === 0) {
      return { success: false, error: `User '${username}' tidak ditemukan.` };
    }

    const user = users[0];

    // Cek apakah sedang online
    const activeSessions = await conn.write("/ppp/active/print", [
      `?name=${username}`,
    ]);

    const isOnline = activeSessions && activeSessions.length > 0;
    const session = isOnline ? activeSessions[0] : null;

    return {
      success: true,
      username,
      profile: user.profile,
      disabled: user.disabled === "true",
      status: user.disabled === "true" ? "🚫 SUSPENDED" : "✅ AKTIF",
      online: isOnline,
      sessionInfo: isOnline
        ? {
            uptime: session.uptime,
            ipAddress: session.address,
            callerID: session["caller-id"],
          }
        : null,
    };
  } catch (error) {
    console.error(`   ❌ Gagal cek status '${username}':`, error.message);
    return { success: false, username, error: error.message };
  } finally {
    if (conn) conn.close();
  }
}

// ============================================================
// 5. DAFTAR SEMUA PPPoE User
// ============================================================
async function listPPPoEUsers() {
  let conn;
  try {
    conn = await connectMikrotik();

    const users = await conn.write("/ppp/secret/print");
    const activeSessions = await conn.write("/ppp/active/print");

    const activeUsernames = activeSessions.map((s) => s.name);

    return {
      success: true,
      total: users.length,
      users: users.map((u) => ({
        username: u.name,
        profile: u.profile,
        disabled: u.disabled === "true",
        status: u.disabled === "true" ? "SUSPENDED" : "AKTIF",
        online: activeUsernames.includes(u.name),
        comment: u.comment || "",
      })),
    };
  } catch (error) {
    console.error("❌ Gagal ambil daftar PPPoE users:", error.message);
    return { success: false, error: error.message };
  } finally {
    if (conn) conn.close();
  }
}

// ============================================================
// 6. TEST KONEKSI KE MIKROTIK
// ============================================================
async function testConnection() {
  let conn;
  try {
    conn = await connectMikrotik();
    const identity = await conn.write("/system/identity/print");
    console.log(`✅ Terhubung ke Mikrotik: ${identity[0]?.name}`);
    return { success: true, identity: identity[0]?.name };
  } catch (error) {
    console.error("❌ Gagal koneksi ke Mikrotik:", error.message);
    return { success: false, error: error.message };
  } finally {
    if (conn) conn.close();
  }
}

module.exports = {
  enablePPPoEUser,
  disablePPPoEUser,
  createPPPoEUser,
  getPPPoEUserStatus,
  listPPPoEUsers,
  testConnection,
};
            
