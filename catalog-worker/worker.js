const CATEGORIES = new Set([
  "Trading Cards", "Coins", "Art & Paintings", "Ceramics & Pottery",
  "Vintage & Collectibles", "Home & Lifestyle", "Food & Beverages", "Other"
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
    paypalCartId: row.paypal_cart_id || "",
    paypal: row.paypal_url || "",
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
  if (typeof input.paypalCartId !== "string" || input.paypalCartId.length > 80) return "Check the PayPal cart button ID.";
  if (typeof input.paypal !== "string" || (input.paypal && !input.paypal.startsWith("https://www.paypal.com/"))) return "PayPal link must begin with https://www.paypal.com/.";
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
  const values = [productId, input.category, input.title.trim(), input.subtitle.trim(), JSON.stringify(input.images), input.price, input.shipping, input.quantity, input.paypalCartId.trim(), input.paypal.trim(), input.status];
  if (id) {
    const result = await env.DB.prepare(`UPDATE products SET category=?,title=?,subtitle=?,images_json=?,price=?,shipping=?,quantity=?,paypal_cart_id=?,paypal_url=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(...values.slice(1), id).run();
    if (!result.meta?.changes) return response({ error: "This listing could not be found." }, 404, headers);
  } else {
    await env.DB.prepare(`INSERT INTO products (id,category,title,subtitle,images_json,price,shipping,quantity,paypal_cart_id,paypal_url,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(...values).run();
  }
  const row = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(productId).first();
  return response({ product: rowToProduct(row) }, id ? 200 : 201, headers);
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

    return response({ error: "Not found." }, 404, headers);
  }
};
