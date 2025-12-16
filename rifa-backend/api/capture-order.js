const { getAdmin } = require("../lib/firebaseAdmin");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch (e) { reject(e); }
    });
  });
}

async function paypalToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  const base = process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const j = await r.json();
  if (!r.ok) throw new Error("PayPal token falló");
  return { access_token: j.access_token, base };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Solo POST" });

  try {
    const body = await readJson(req);
    const { raffleId, orderID, purchaseId } = body;

    if (!raffleId || !orderID || !purchaseId) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const admin = getAdmin();
    const db = admin.firestore();

    const raffleRef = db.collection("raffles").doc(raffleId);
    const purchaseRef = db.collection("purchases").doc(purchaseId);

    // 1) Capturar pago en PayPal
    const { access_token, base } = await paypalToken();

    const r = await fetch(`${base}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${access_token}`, "Content-Type": "application/json" }
    });
    const j = await r.json();
    if (!r.ok) return res.status(400).json({ error: "No se pudo capturar el pago" });

    // 2) Asignar boletos + actualizar Firestore (transacción)
    let assigned = [];
    await db.runTransaction(async (tx) => {
      const [raffleSnap, purSnap] = await Promise.all([tx.get(raffleRef), tx.get(purchaseRef)]);
      if (!raffleSnap.exists) throw new Error("Rifa no existe");
      if (!purSnap.exists) throw new Error("Compra no existe");

      const raffle = raffleSnap.data();
      const pur = purSnap.data();

      if (pur.status === "paid") {
        assigned = Array.isArray(pur.tickets) ? pur.tickets : [];
        return;
      }
      if (pur.paypalOrderId !== orderID) throw new Error("OrderID no coincide");

      const total = Number(raffle.totalTickets || 0);
      const sold = Number(raffle.soldTickets || 0);
      const taken = Array.isArray(raffle.takenTickets) ? raffle.takenTickets.map(Number) : [];
      const q = Number(pur.qty || 0);

      const remaining = Math.max(0, total - sold);
      if (q > remaining) throw new Error(`Ya no hay suficientes boletos (quedan ${remaining})`);

      const used = new Set(taken);
      const available = [];
      for (let i=1;i<=total;i++) if (!used.has(i)) available.push(i);

      // mezclar
      for (let i = available.length - 1; i > 0; i--) {
        const k = Math.floor(Math.random() * (i + 1));
        [available[i], available[k]] = [available[k], available[i]];
      }

      assigned = available.slice(0, q);

      // buyersCount “simple”: cuenta compras (si quieres único por WhatsApp, lo ajustamos después)
      const buyersCount = Number(raffle.buyersCount || 0) + 1;

      tx.update(raffleRef, {
        soldTickets: sold + q,
        buyersCount,
        takenTickets: admin.firestore.FieldValue.arrayUnion(...assigned),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.update(purchaseRef, {
        status: "paid",
        tickets: assigned,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        paypalStatus: j.status || "COMPLETED",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ ok: true, tickets: assigned });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
};
