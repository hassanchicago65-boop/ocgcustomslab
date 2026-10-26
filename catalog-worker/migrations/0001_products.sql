CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL,
  price REAL NOT NULL,
  shipping REAL NOT NULL DEFAULT 0,
  quantity INTEGER,
  paypal_cart_id TEXT NOT NULL DEFAULT '',
  paypal_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'For Sale',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS products_status_category ON products(status, category);

INSERT OR IGNORE INTO products
(id, category, title, subtitle, images_json, price, shipping, quantity, paypal_cart_id, paypal_url, status)
VALUES
('alohi-gilman-slab','Trading Cards','Alohi Gilman OCG Custom Slab','2026 Topps • 2025 Greatest Hits • #25GH-AG','["https://ocgcustomslab.com/mobile-images/alohi-gilman-front.jpg","https://ocgcustomslab.com/mobile-images/alohi-gilman-back.jpg"]',7,4.99,NULL,'VZSULZ8ZBVYLW','https://www.paypal.com/ncp/payment/HJS423LK4R4NL','For Sale'),
('austria-1974-10-schilling','Coins','1974 Austria 10 Schilling Copper-Nickel Coin','Ungraded • Fine to Very Fine','["https://ocgcustomslab.com/mobile-images/austria-1974-10-schilling.jpg"]',3.5,1.36,NULL,'RAHMDZF2PPXPL','https://www.paypal.com/ncp/payment/BH3J45N5CT','For Sale')
