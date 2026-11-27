#!/usr/bin/env python3
"""Replace the native iOS cart view in the app source archive."""
from pathlib import Path
import sys
if len(sys.argv) != 2:
    raise SystemExit("Usage: patch-ios-cart.py path/to/App.swift")
app_path = Path(sys.argv[1])
overlay_path = Path("CartView.swift")
source = app_path.read_text()
replacement = overlay_path.read_text().rstrip()
start_marker = "struct CartView: View {"
end_marker = "\nstruct CollectionView: View {"
if source.count(start_marker) != 1:
    raise SystemExit(f"Expected one {start_marker!r} in {app_path}")
start = source.index(start_marker)
end = source.find(end_marker, start)
if end == -1:
    raise SystemExit(f"Could not find {end_marker.strip()!r} after cart view")
app_path.write_text(source[:start] + replacement + source[end:])
source = app_path.read_text()
website_link = '''                Link(destination: product.websiteURL) {
                    HStack { Text("Shop this item on OCG"); Spacer(); Image(systemName: "arrow.up.right") }
                        .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(16)
                        .foregroundStyle(.white).background(OCGStyle.navy, in: RoundedRectangle(cornerRadius: 12))
                }
'''
if source.count(website_link) != 1:
    raise SystemExit("Expected exactly one product website link in App.swift")
source = source.replace(website_link, "")
old_copy = "Complete your purchase on our website. Availability, delivery options, tax and the final total are shown there."
new_copy = "Checkout securely in the app. Shipping, tax and your final total are shown before you pay."
if source.count(old_copy) != 1:
    raise SystemExit("Expected exactly one website checkout message in App.swift")
source = source.replace(old_copy, new_copy)
app_path.write_text(source)
