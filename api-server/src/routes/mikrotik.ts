import { Router, type IRouter } from "express";
// @ts-ignore - node-routeros doesn't have proper types
import { RouterOSAPI } from "node-routeros";

const router: IRouter = Router();

const TIMEOUT = 8000;

async function connectRouter(host: string, username: string, password: string, port = 8728): Promise<RouterOSAPI> {
  const api = new RouterOSAPI({ host, user: username, password, port, timeout: TIMEOUT });
  await api.connect();
  return api;
}

function isPrivateIp(host: string): boolean {
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/* ─── PING / SYSTEM INFO ─── */
router.post("/mikrotik/ping", async (req, res) => {
  const { host, username, password, port } = req.body;
  if (!host || !username) {
    res.status(400).json({ error: "host و username مطلوبان" });
    return;
  }

  let api: RouterOSAPI | null = null;
  try {
    api = await connectRouter(host, username, password || "", Number(port) || 8728);
    const [resource] = await api.write("/system/resource/print");
    const [identity] = await api.write("/system/identity/print");

    res.json({
      online: true,
      board: resource?.["board-name"] || "",
      version: resource?.version || "",
      uptime: resource?.uptime || "",
      cpuLoad: resource?.["cpu-load"] ? parseInt(resource["cpu-load"]) : null,
      freeMemory: resource?.["free-memory"] ? parseInt(resource["free-memory"]) : null,
      totalMemory: resource?.["total-memory"] ? parseInt(resource["total-memory"]) : null,
      identity: identity?.name || "",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isPrivate = isPrivateIp(host);
    res.json({
      online: false,
      error: msg,
      reason: isPrivate ? "PRIVATE_IP" : "CONNECTION_FAILED",
      hint: isPrivate
        ? "هذا IP داخلي - السيرفر على الإنترنت لا يستطيع الوصول إليه"
        : "تأكد من تفعيل API في MikroTik وفتح المنفذ في الجدار الناري",
    });
  } finally {
    try { api?.close(); } catch {}
  }
});

/* ─── DISCOVER DEVICES ─── */
router.post("/mikrotik/discover", async (req, res) => {
  const { host, username, password, port, subnet, deviceFilter } = req.body;
  if (!host || !username) {
    res.status(400).json({ error: "host و username مطلوبان" });
    return;
  }

  let api: RouterOSAPI | null = null;
  try {
    api = await connectRouter(host, username, password || "", Number(port) || 8728);

    const [arpList, neighborList, dhcpList] = await Promise.all([
      api.write("/ip/arp/print").catch(() => []),
      api.write("/ip/neighbor/print").catch(() => []),
      api.write("/ip/dhcp-server/lease/print").catch(() => []),
    ]);

    const devices: Record<string, { ip: string; mac: string; hostname: string; type: string; interface: string; source: string }> = {};

    for (const item of arpList as Record<string, string>[]) {
      if (!item.address) continue;
      if (subnet && !item.address.startsWith(subnet.split("/")[0].split(".").slice(0, 3).join("."))) continue;
      const key = item.address;
      devices[key] = {
        ip: item.address,
        mac: item["mac-address"] || "",
        hostname: "",
        type: "جهاز شبكة",
        interface: item.interface || "",
        source: "ARP",
      };
    }

    for (const item of dhcpList as Record<string, string>[]) {
      if (!item.address) continue;
      const key = item.address;
      if (devices[key]) {
        devices[key].hostname = item.hostname || devices[key].hostname;
        devices[key].mac = item["mac-address"] || devices[key].mac;
        devices[key].source = "DHCP";
      } else {
        devices[key] = {
          ip: item.address,
          mac: item["mac-address"] || "",
          hostname: item.hostname || "",
          type: "جهاز شبكة",
          interface: "",
          source: "DHCP",
        };
      }
    }

    for (const item of neighborList as Record<string, string>[]) {
      if (!item.address) continue;
      const key = item.address;
      const isMikrotik = (item["system-description"] || "").toLowerCase().includes("mikrotik")
        || (item.identity || "").length > 0;
      const devType = isMikrotik ? "راوتر MikroTik" : "جهاز شبكة";
      if (devices[key]) {
        devices[key].type = devType;
        devices[key].hostname = item.identity || item["system-name"] || devices[key].hostname;
        devices[key].source = "Neighbor";
      } else {
        devices[key] = {
          ip: item.address,
          mac: item["mac-address"] || "",
          hostname: item.identity || item["system-name"] || "",
          type: devType,
          interface: item.interface || "",
          source: "Neighbor",
        };
      }
    }

    let result = Object.values(devices);

    if (deviceFilter && deviceFilter !== "كل الأجهزة") {
      result = result.filter(d => d.type === deviceFilter);
    }

    res.json({ devices: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  } finally {
    try { api?.close(); } catch {}
  }
});

/* ─── USER MANAGER PACKAGES ─── */
router.post("/mikrotik/packages", async (req, res) => {
  const { host, username, password, port } = req.body;
  if (!host || !username) {
    res.status(400).json({ error: "host و username مطلوبان" });
    return;
  }

  let api: RouterOSAPI | null = null;
  try {
    api = await connectRouter(host, username, password || "", Number(port) || 8728);
    const profiles = await api.write("/tool/user-manager/profile/print");
    const packages = (profiles as Record<string, string>[]).map(p => p.name).filter(Boolean);
    res.json({ packages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  } finally {
    try { api?.close(); } catch {}
  }
});

/* ─── SALES REPORT ─── */
router.post("/mikrotik/sales-report", async (req, res) => {

  const {
    host,
    username,
    password,
    port,
    packageName
  } = req.body;

  if (!host || !username) {

    res.status(400).json({
      error: "host و username مطلوبان"
    });

    return;
  }

  let api: RouterOSAPI | null = null;

  try {

    api = await connectRouter(
      host,
      username,
      password || "",
      Number(port) || 8728
    );

    // MikroTik User Manager v6
const users =
  await api.write(
    "/tool/user-manager/user/getall"
  ) as Record<string,string>[];


    const counts: Record<string, number> = {};

    for (const u of users) {

      const profile =
        u["actual-profile"] ||
        u.profile ||
        u["profile-name"] ||
        "غير معروف";

      if (
        packageName &&
        packageName !== "جميع الباقات" &&
        profile !== packageName
      ) {
        continue;
      }

      counts[profile] =
        (counts[profile] || 0) + 1;
    }

    const rows = Object.entries(counts)
      .map(([pkg, count]) => ({
        package: pkg,
        count
      }))
      .sort((a, b) => b.count - a.count);

    console.log("SALES:", rows);

    res.json({
      success: true,
      total: rows.reduce(
        (s, r) => s + r.count,
        0
      ),
      rows
    });

  } catch (err: unknown) {

    const msg =
      err instanceof Error
        ? err.message
        : String(err);

    console.error(
      "SALES REPORT ERROR:",
      msg
    );

    res.status(500).json({
      error: msg
    });

  } finally {

    try {
      api?.close();
    } catch {}

  }
});


/* ─── USER MANAGER USERS (مع اليوزرات والياقات) ─── */
router.post("/mikrotik/um-users", async (req, res) => {
  const { host, username, password, port, search, profileFilter, statusFilter, limit = 200 } = req.body;
  if (!host || !username) {
    res.status(400).json({ error: "host و username مطلوبان" });
    return;
  }

  let api: RouterOSAPI | null = null;
  try {
    api = await connectRouter(host, username, password || "", Number(port) || 8728);

    const [users, profiles, activeSessions] = await Promise.all([
      api.write("/tool/user-manager/user/print").catch(() => []),
      api.write("/tool/user-manager/profile/print").catch(() => []),
      api.write("/tool/user-manager/user/active/print").catch(() => []),
    ]);

    const activeSet = new Set(
      (activeSessions as Record<string, string>[]).map(s => s.username || s.name || "")
    );

    const profileMap: Record<string, Record<string, string>> = {};
    for (const p of profiles as Record<string, string>[]) {
      if (p.name) profileMap[p.name] = p;
    }

    let result = (users as Record<string, string>[]).map(u => ({
      username: u.username || u.name || "",
      profile: u.profile || u["profile-name"] || "",
      comment: u.comment || "",
      disabled: u.disabled === "true",
      "shared-users": u["shared-users"] || "1",
      "caller-id": u["caller-id"] || "",
      "created-on": u["created-on"] || "",
      "end-time": u["end-time"] || "",
      "limit-bytes-in": u["limit-bytes-in"] || "",
      "limit-bytes-out": u["limit-bytes-out"] || "",
      "actual-profile": profileMap[u.profile || u["profile-name"] || ""] || null,
      isActive: activeSet.has(u.username || u.name || ""),
    }));

    if (search) {
      const q = (search as string).toLowerCase();
      result = result.filter(u =>
        u.username.toLowerCase().includes(q) ||
        u.profile.toLowerCase().includes(q) ||
        (u.comment || "").toLowerCase().includes(q)
      );
    }
    if (profileFilter && profileFilter !== "الكل") {
      result = result.filter(u => u.profile === profileFilter);
    }
    if (statusFilter === "نشط") result = result.filter(u => u.isActive);
    if (statusFilter === "معطل") result = result.filter(u => u.disabled);

    const profiles_list = (profiles as Record<string, string>[]).map(p => p.name).filter(Boolean);

    res.json({
      users: result.slice(0, Number(limit)),
      total: result.length,
      profiles: profiles_list,
      activeCount: result.filter(u => u.isActive).length,
      disabledCount: result.filter(u => u.disabled).length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  } finally {
    try { api?.close(); } catch {}
  }
});

export default router;
