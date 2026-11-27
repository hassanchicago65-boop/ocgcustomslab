const CATEGORIES = new Set([
   "Trading Cards", "Coins", "Art & Paintings", "Ceramics & Pottery",
  "Vintage & Collectibles", "Home & Lifestyle", 
  "Clothing & Accessories", "Electronics",  "Food & Beverages", "Other" 
   
]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function response(body, status = 200, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  }});
}

function cors(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = origin === env.ALLOWED_ORIGIN ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function authorized(request, env) {
  const expected = env.ADMIN_KEY;
  const supplied = request.headers.get("Authorization") || "";
  return Boolean(expected && supplied === `Bearer ${expected}`);
}

function rowToProduct(row) {
  let images = [];
  try { images = JSON.parse(row.images_json || "[]"); } catch {}
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    subtitle: row.subtitle || "",
    images,
    price: Number(row.price),
    shipping: Number(row.shipping || 0),
    quantity: row.quantity == null ? null : Number(row.quantity),
    stripeUrl: row.stripe_url || "",
    
    status: row.status
  };
}

async function listProducts(env, publicOnly = false) {
  const query = publicOnly
    ? "SELECT * FROM products WHERE status = 'For Sale' ORDER BY category, title"
    : "SELECT * FROM products ORDER BY updated_at DESC, title";
  const { results = [] } = await env.DB.prepare(query).all();
  return results.map(rowToProduct);
}

function makeId(title) {
  const slug = title.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

function validProduct(input) {
  if (!input || typeof input !== "object") return "Product information is missing.";
  if (!CATEGORIES.has(input.category)) return "Choose a valid category.";
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 140) return "Enter an item title (up to 140 characters).";
  if (typeof input.subtitle !== "string" || input.subtitle.length > 2048) return "Description must be 2,048 characters or less.";
  if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > 5) return "Add 1 to 5 item photos.";
  if (!input.images.every(url => typeof url === "string" && url.startsWith("https://ocgcustomslab.com/"))) return "Item photos must use the OCG website image address.";
  if (!Number.isFinite(input.price) || input.price < 0 || input.price > 1000000) return "Enter a valid item price.";
  if (!Number.isFinite(input.shipping) || input.shipping < 0 || input.shipping > 100000) return "Enter a valid shipping fee.";
  if (input.quantity !== null && (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 1000000)) return "Enter a whole-number stock quantity.";
    if (typeof input.stripeUrl !== "string" || (input.stripeUrl && !input.stripeUrl.startsWith("https://buy.stripe.com/"))) return "Enter a valid Stripe payment link.";
   
  if (!["For Sale", "Draft", "Archived"].includes(input.status)) return "Choose a valid listing status.";
  return "";
}

async function uploadImages(request, env, headers) {
  if (!authorized(request, env)) return response({ error: "Sign in with your admin key again." }, 401, headers);
  const form = await request.formData();
  const files = form.getAll("photos").filter(value => value instanceof File && value.size > 0);
  if (files.length < 1 || files.length > 5) return response({ error: "Choose between 1 and 5 photos." }, 400, headers);
  const urls = [];
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) return response({ error: "Each photo must be 8 MB or smaller." }, 400, headers);
    const mime = file.type.toLowerCase();
    const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" })[mime];
    if (!ext) return response({ error: "Use JPG, PNG, WebP, or AVIF photos." }, 400, headers);
    const key = `${crypto.randomUUID()}.${ext}`;
    await env.IMAGES.put(key, file.stream(), { httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" } });
    urls.push(`https://ocgcustomslab.com/catalog-images/${key}`);
  }
  return response({ images: urls }, 201, headers);
}

async function saveProduct(request, env, headers, id = "") {
  if (!authorized(request, env)) return response({ error: "Sign in with your admin key again." }, 401, headers);
  let input;
  try { input = await request.json(); } catch { return response({ error: "Product form is not valid." }, 400, headers); }
  const issue = validProduct(input);
  if (issue) return response({ error: issue }, 400, headers);
  const productId = id || makeId(input.title);
 const values = [productId, input.category, input.title.trim(), input.subtitle.trim(), JSON.stringify(input.images), input.price, input.shipping, input.quantity, input.paypalCartId.trim(), input.paypal.trim(), input.stripeUrl.trim(), input.status]; 
  if (id) {
const result = await env.DB.prepare("UPDATE products SET category=?,title=?,subtitle=?,images_json=?,price=?,shipping=?,quantity=?,paypal_cart_id=?,paypal_url=?,stripe_url=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(...values.slice(1), id).run();
    if (!result.meta?.changes) return response({ error: "This listing could not be found." }, 404, headers);
  } else {
 await env.DB.prepare("INSERT INTO products (id,category,title,subtitle,images_json,price,shipping,quantity,paypal_cart_id,paypal_url,stripe_url,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)") 
      .bind(...values).run();
  }
  const row = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(productId).first();
  return response({ product: rowToProduct(row) }, id ? 200 : 201, headers);
}
async function createStripeCheckout(request, env, headers) {
  const secret = env.STRIPE_SECRET_KEY || env.STRIPE_SECRET;
  if (!secret) {
    return response({ error: "Worker secret STRIPE_SECRET_KEY is missing." }, 503, headers);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return response({ error: "Cart data is invalid." }, 400, headers);
  }

  if (!Array.isArray(input.items) || input.items.length < 1) {
    return response({ error: "Your cart is empty." }, 400, headers);
  }

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", "https://ocgcustomslab.com/?checkout=success");
  form.set("cancel_url", "https://ocgcustomslab.com/?checkout=cancelled");
  form.set("automatic_tax[enabled]", "true");
  form.set("shipping_address_collection[allowed_countries][0]", "US");

  let line = 0;

  for (const item of input.items) {
    if (
      typeof item.id !== "string" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1
    ) {
      return response({ error: "Invalid item quantity." }, 400, headers);
    }

    const p = await env.DB.prepare(
      "SELECT id,title,price,shipping,quantity,status FROM products WHERE id=?"
    ).bind(item.id).first();

    if (!p || p.status !== "For Sale") {
      return response({ error: "An item is no longer for sale." }, 409, headers);
    }

    if (p.quantity != null && item.quantity > Number(p.quantity)) {
      return response({
        error: `${p.title} has only ${p.quantity} in stock.`
      }, 409, headers);
    }

    const addLine = (name, cents, qty) => {
      form.set(`line_items[${line}][price_data][currency]`, "usd");
      form.set(`line_items[${line}][price_data][unit_amount]`, String(cents));
      form.set(`line_items[${line}][price_data][product_data][name]`, name);
      form.set(`line_items[${line}][quantity]`, String(qty));
      line++;
    };

    addLine(p.title, Math.round(Number(p.price) * 100), item.quantity);

    const shipping = Math.round(Number(p.shipping || 0) * 100) + (Number(p.shipping || 0) > 0 ? Math.max(0, item.quantity - 1) * 50 : 0);
    if (shipping > 0) addLine(p.title + " shipping", shipping, 1);
  }

  const stripe = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const result = await stripe.json();

  if (!stripe.ok || !result.url) {
    return response({
      error: result.error?.message || "Stripe checkout could not start."
    }, 502, headers);
  }

  return response({ url: result.url }, 200, headers);
}

async function createNativePaymentIntent(request, env, headers) {
  const secret = env.STRIPE_SECRET_KEY || env.STRIPE_SECRET;
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY;
  if (!secret) return response({ error: "Worker secret STRIPE_SECRET_KEY is missing." }, 503, headers);
  if (!publishableKey || !publishableKey.startsWith("pk_")) {
    return response({ error: "Worker variable STRIPE_PUBLISHABLE_KEY is missing or invalid." }, 503, headers);
  }

  let input;
  try { input = await request.json(); }
  catch { return response({ error: "Checkout information is invalid." }, 400, headers); }

  const address = input?.shippingAddress;
  const required = [address?.name, address?.email, address?.line1, address?.city, address?.state, address?.postalCode];
  if (!Array.isArray(input?.items) || input.items.length < 1 || input.items.length > 20 ||
      required.some(value => typeof value !== "string" || !value.trim()) ||
      !address.email.includes("@") || address.state.trim().length !== 2 ||
      String(address.country || "US").toUpperCase() !== "US") {
    return response({ error: "Enter a complete U.S. shipping address and check your cart." }, 400, headers);
  }

  const form = new URLSearchParams();
  form.set("currency", "usd");
  form.set("customer_details[address_source]", "shipping");
  form.set("customer_details[address][country]", "US");
  form.set("customer_details[address][line1]", address.line1.trim());
  if (address.line2?.trim()) form.set("customer_details[address][line2]", address.line2.trim());
  form.set("customer_details[address][city]", address.city.trim());
  form.set("customer_details[address][state]", address.state.trim().toUpperCase());
  form.set("customer_details[address][postal_code]", address.postalCode.trim());

  let shippingCents = 0;
  let itemCount = 0;
  for (const item of input.items) {
    if (typeof item?.id !== "string" || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      return response({ error: "A cart quantity is invalid." }, 400, headers);
    }
    const product = await env.DB.prepare(
      "SELECT id,title,category,price,shipping,quantity,status FROM products WHERE id=?"
    ).bind(item.id).first();
    if (!product || product.status !== "For Sale") return response({ error: "An item is no longer for sale." }, 409, headers);
    if (product.quantity != null && item.quantity > Number(product.quantity)) {
      return response({ error: `${product.title} has only ${product.quantity} in stock.` }, 409, headers);
    }

    const index = itemCount++;
    const amount = Math.round(Number(product.price) * 100) * item.quantity;
    if (!Number.isSafeInteger(amount) || amount < 0) return response({ error: "An item price is invalid." }, 400, headers);
    form.set(`line_items[${index}][amount]`, String(amount));
    form.set(`line_items[${index}][reference]`, product.id);
    form.set(`line_items[${index}][tax_code]`, "txcd_99999999");
    form.set(`line_items[${index}][tax_behavior]`, "exclusive");
    shippingCents += Math.round(Number(product.shipping || 0) * 100) + (Number(product.shipping || 0) > 0 ? Math.max(0, item.quantity - 1) * 50 : 0);
  }
  if (shippingCents > 0) {
    form.set("shipping_cost[amount]", String(shippingCents));
    form.set("shipping_cost[tax_code]", "txcd_92010001");
    form.set("shipping_cost[tax_behavior]", "exclusive");
  }

  const auth = `Basic ${btoa(`${secret}:`)}`;
  const calculationResponse = await fetch("https://api.stripe.com/v1/tax/calculations", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  const calculation = await calculationResponse.json();
  if (!calculationResponse.ok || !Number.isSafeInteger(calculation.amount_total)) {
    return response({ error: calculation.error?.message || "Tax and order total could not be calculated." }, 502, headers);
  }

  const payment = new URLSearchParams();
  payment.set("amount", String(calculation.amount_total));
  payment.set("currency", "usd");
  payment.set("automatic_payment_methods[enabled]", "true");
  payment.set("description", "OCG Custom Slab order");
  payment.set("receipt_email", address.email.trim());
  payment.set("shipping[name]", address.name.trim());
  payment.set("shipping[address][country]", "US");
  payment.set("shipping[address][line1]", address.line1.trim());
  if (address.line2?.trim()) payment.set("shipping[address][line2]", address.line2.trim());
  payment.set("shipping[address][city]", address.city.trim());
  payment.set("shipping[address][state]", address.state.trim().toUpperCase());
  payment.set("shipping[address][postal_code]", address.postalCode.trim());
  payment.set("metadata[tax_calculation_id]", calculation.id);

  const intentResponse = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: payment
  });
  const intent = await intentResponse.json();
  if (!intentResponse.ok || !intent.client_secret) {
    return response({ error: intent.error?.message || "In-app payment could not be prepared." }, 502, headers);
  }
  return response({
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    publishableKey,
    amount: calculation.amount_total,
    tax: calculation.tax_amount_exclusive || 0
  }, 200, headers);
}

async function recordNativePayment(request, env, headers) {
  const secret = env.STRIPE_SECRET_KEY || env.STRIPE_SECRET;
  if (!secret) return response({ error: "Worker secret STRIPE_SECRET_KEY is missing." }, 503, headers);
  let input;
  try { input = await request.json(); }
  catch { return response({ error: "Payment confirmation is invalid." }, 400, headers); }
  if (typeof input?.paymentIntentId !== "string" || !/^pi_[A-Za-z0-9]+$/.test(input.paymentIntentId)) {
    return response({ error: "Payment reference is invalid." }, 400, headers);
  }
  const auth = `Basic ${btoa(`${secret}:`)}`;
  const intentResponse = await fetch(`https://api.stripe.com/v1/payment_intents/${input.paymentIntentId}`, {
    headers: { Authorization: auth }
  });
  const intent = await intentResponse.json();
  if (!intentResponse.ok) return response({ error: intent.error?.message || "Payment could not be verified." }, 502, headers);
  if (intent.status !== "succeeded") return response({ error: "Payment has not completed yet." }, 409, headers);
  const calculationId = intent.metadata?.tax_calculation_id;
  if (typeof calculationId !== "string" || !calculationId.startsWith("taxcalc_")) {
    return response({ error: "The tax record for this order could not be found." }, 409, headers);
  }

  const transaction = new URLSearchParams();
  transaction.set("calculation", calculationId);
  transaction.set("reference", intent.id);
  transaction.set("expand[]", "line_items");
  const recordResponse = await fetch("https://api.stripe.com/v1/tax/transactions/create_from_calculation", {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `ocg-tax-${intent.id}`
    },
    body: transaction
  });
  const record = await recordResponse.json();
  if (!recordResponse.ok) return response({ error: record.error?.message || "The tax record is still processing." }, 502, headers);
  return response({ recorded: true, taxTransactionId: record.id }, 200, headers);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    if (url.pathname.startsWith("/catalog-images/")) {
      const key = decodeURIComponent(url.pathname.slice("/catalog-images/".length));
      if (!key || key.includes("/") || key.includes("..")) return new Response("Not found", { status: 404 });
      const object = await env.IMAGES.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const h = new Headers();
      object.writeHttpMetadata(h);
      h.set("Cache-Control", "public, max-age=31536000, immutable");
      h.set("ETag", object.httpEtag);
      return new Response(object.body, { headers: h });
    }

    if ((url.pathname === "/catalog.json" || url.pathname === "/catalog-api/catalog") && request.method === "GET") {
      try { return response(JSON.stringify(await listProducts(env, true)), 200, { ...headers, "Cache-Control": "public, max-age=30, stale-while-revalidate=120" }); }
      catch { return response({ error: "Catalog is not ready." }, 503, headers); }
    }

    if (url.pathname === "/catalog-api/images" && request.method === "POST") return uploadImages(request, env, headers);
    if (url.pathname === "/catalog-api/admin/products" && request.method === "GET") {
      if (!authorized(request, env)) return response({ error: "Sign in with your admin key again." }, 401, headers);
      try { return response({ products: await listProducts(env) }, 200, headers); }
      catch { return response({ error: "Catalog database is not ready." }, 503, headers); }
    }
    if (url.pathname === "/catalog-api/admin/products" && request.method === "POST") return saveProduct(request, env, headers);
    const editMatch = url.pathname.match(/^\/catalog-api\/admin\/products\/([a-z0-9-]+)$/);
    if (editMatch && request.method === "PUT") return saveProduct(request, env, headers, editMatch[1]);
    if (url.pathname === "/catalog-api/checkout/intent" && request.method === "POST") return createNativePaymentIntent(request, env, headers);
    if (url.pathname === "/catalog-api/checkout/complete" && request.method === "POST") return recordNativePayment(request, env, headers);
    if (url.pathname === "/catalog-api/checkout" && request.method === "POST") return createStripeCheckout(request, env, headers);
    return response({ error: "Not found." }, 404, headers);
  }
};
