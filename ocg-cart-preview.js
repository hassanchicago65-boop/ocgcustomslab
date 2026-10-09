
/* OCG Shopping Cart — Test Version */
(() => {
  if (new URLSearchParams(location.search)
      .get("cartPreview") !== "1") return;

  const products = window.OCG_PRODUCTS || [];
  const cart = {};
  const money = n => "$" + Number(n || 0).toFixed(2);

  const style = document.createElement("style");
  style.textContent = `
    .ocg-add,.ocg-open {
      background:linear-gradient(90deg,#D9A438,#E9B949);
      color:#061b33;
      border:0;
      border-radius:9px;
      padding:14px 20px;
      font-weight:bold;
      cursor:pointer;
    }
    .ocg-add {width:100%;margin:12px 0}
    .ocg-open {
      position:fixed;bottom:20px;right:20px;
      z-index:9999;
    }
    .ocg-panel {
      display:none;position:fixed;inset:0;
      background:#0008;z-index:10000;
      padding:15px;
    }
    .ocg-box {
      background:white;border-radius:14px;
      padding:22px;max-width:480px;
      margin:40px auto;max-height:80vh;
      overflow:auto;
    }
    .ocg-item {
      padding:12px 0;
      border-bottom:1px solid #ddd;
    }
    .ocg-box button {
      margin:5px;padding:8px;
      cursor:pointer;
    }
  `;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.className = "ocg-panel";
  panel.innerHTML = `
    <div class="ocg-box">
      <button id="ocg-close">Close ✕</button>
      <h2>OCG Shopping Cart</h2>
      <p>TEST ONLY — No payment yet</p>
      <div id="ocg-items"></div>
      <h3 id="ocg-total"></h3>
      <button disabled>PayPal Checkout (Coming Soon)</button>
    </div>
  `;
  document.body.appendChild(panel);

  const open = document.createElement("button");
  open.className = "ocg-open";
  document.body.appendChild(open);

  function showCart() {
    const list = document.getElementById("ocg-items");
    list.replaceChildren();
    let total = 0, count = 0;

    products.forEach(p => {
      const qty = cart[p.id] || 0;
      if (!qty) return;
      count += qty;
      total += qty * Number(p.price || 0);

      const div = document.createElement("div");
      div.className = "ocg-item";

      const name = document.createElement("strong");
      name.textContent = p.title;
      div.appendChild(name);

      const info = document.createElement("p");
      info.textContent = money(p.price) + " × " + qty;
      div.appendChild(info);

      [
        ["−", -1],
        ["+", 1],
        ["Remove", 0]
      ].forEach(([label, change]) => {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.onclick = () => {
          if (change === 0) delete cart[p.id];
          else {
            cart[p.id] = Math.max(0, qty + change);
            if (!cart[p.id]) delete cart[p.id];
          }
          showCart();
        };
        div.appendChild(btn);
      });

      list.appendChild(div);
    });

    if (!count) list.textContent = "Your cart is empty.";
    document.getElementById("ocg-total").textContent =
      "Subtotal: " + money(total);
    open.textContent = "🛒 Cart (" + count + ")";
  }

  function decorate() {
    document.querySelectorAll("article.product")
      .forEach(article => {
        if (article.querySelector(".ocg-add")) return;

        const img = article.querySelector(".product-main");
        const p = products.find(x =>
          img && img.getAttribute("src") === x.image
        );
        if (!p) return;

        const btn = document.createElement("button");
        btn.className = "ocg-add";
        btn.textContent = "🛒 Add to Cart";

        btn.onclick = () => {
          cart[p.id] = (cart[p.id] || 0) + 1;
          showCart();
          panel.style.display = "block";
        };

        const paypal = article.querySelector(
          "paypal-add-to-cart-button, a.paypal"
        );

        if (paypal) {
          paypal.style.display = "none";
          paypal.before(btn);
        } else {
          article.querySelector(".product-body").append(btn);
        }
      });
  }

  open.onclick = () => panel.style.display = "block";
  document.getElementById("ocg-close").onclick =
    () => panel.style.display = "none";

  new MutationObserver(decorate).observe(
    document.body, {childList:true,subtree:true}
  );

  decorate();
  showCart();
})();
