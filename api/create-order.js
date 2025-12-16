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

  if (!id || !secret) throw new Error("Falta PAYPAL_CLIENT_ID o PAYPAL_SECRET");

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
    const { raffleId, name, wa, qty } = body;

    if (!raffleId || !name || !wa) return res.status(400).json({ error: "Faltan datos" });

    const q = Number(qty);
    if (!Number.isInteger(q) || q < 1 || q > 5) return res.status(400).json({ error: "Cantidad inválida" });

    const admin = getAdmin();
    const db = admin.firestore();

    const raffleRef = db.collection("raffles").doc(raffleId);
    const snap = await raffleRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Rifa no existe" });

    const raffle = snap.data();
    const total = Number(raffle.totalTickets || 0);
    const sold = Number(raffle.soldTickets || 0);
    const price = Number(raffle.ticketPrice || 0);

    const endsAtMs = raffle.endsAt?.toDate ? raffle.endsAt.toDate().getTime() : 0;
    if (endsAtMs && Date.now() > endsAtMs) return res.status(400).json({ error: "Rifa finalizada" });

    const remaining = Math.max(0, total - sold);
    if (q > remaining) return res.status(400).json({ error: `Solo quedan ${remaining} boletos` });

    const amount = (q * price).toFixed(2);

    const { access_token, base } = await paypalToken();

    const r = await fetch(`${base}/v2/checkout/orders`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "MXN", value: amount } }],
        application_context: { shipping_preference: "NO_SHIPPING" }
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(400).json({ error: "No se pudo crear la orden PayPal" });

    const orderID = j.id;

    const purchaseRef = await db.collection("purchases").add({
      raffleId,
      name: String(name).trim(),
      wa: String(wa).trim(),
      qty: q,
      amountMXN: amount,
      status: "created",
      paypalOrderId: orderID,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({ orderID, purchaseId: purchaseRef.id });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
};
