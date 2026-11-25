struct CartView: View {
    @EnvironmentObject private var store: Store
    @State private var isCheckingOut = false
    @State private var checkoutError: String?

    private struct CheckoutItem: Encodable {
        let id: String
        let quantity: Int
    }

    private struct CheckoutRequest: Encodable {
        let items: [CheckoutItem]
    }

    private struct CheckoutResponse: Decodable {
        let url: URL?
        let error: String?
    }

    var body: some View {
        NavigationStack {
            Group {
                if store.cartLines.isEmpty {
                    ContentUnavailableView("Your cart is empty", systemImage: "cart", description: Text("Add an item from the shop to start your order."))
                } else {
                    List {
                        Section("Items") {
                            ForEach(store.cartLines) { line in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(alignment: .top) {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(line.product.title).font(.headline)
                                            Text(line.product.category).font(.caption).foregroundStyle(.secondary)
                                            Text(line.product.price, format: .currency(code: "USD"))
                                                .font(.subheadline.weight(.semibold))
                                        }
                                        Spacer()
                                        Button(role: .destructive) { store.removeFromCart(line.product.id) } label: {
                                            Image(systemName: "trash")
                                        }.accessibilityLabel("Remove \(line.product.title) from cart")
                                    }
                                    Stepper("Quantity: \(line.quantity)", value: Binding(
                                        get: { store.cart[line.product.id] ?? line.quantity },
                                        set: { store.setCartQuantity($0, for: line.product.id) }
                                    ), in: 1...99)
                                    Text("Listed shipping: \((line.product.shipping * Double(line.quantity)).formatted(.currency(code: "USD")))")
                                        .font(.caption).foregroundStyle(.secondary)
                                }.padding(.vertical, 4)
                            }
                        }
                        Section("Estimated total") {
                            LabeledContent("Items", value: store.cartSubtotal.formatted(.currency(code: "USD")))
                            LabeledContent("Listed shipping", value: store.cartShippingEstimate.formatted(.currency(code: "USD")))
                            LabeledContent("Before tax", value: (store.cartSubtotal + store.cartShippingEstimate).formatted(.currency(code: "USD")))
                            Text("Stock, tax, and final shipping are confirmed at checkout.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Section("Payment") {
                            Button {
                                Task { await startCheckout() }
                            } label: {
                                HStack {
                                    if isCheckingOut { ProgressView().tint(.white) }
                                    Text(isCheckingOut ? "Opening Stripe…" : "Checkout with Stripe")
                                    Spacer()
                                    Image(systemName: "arrow.up.right")
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(OCGStyle.navy)
                            .disabled(isCheckingOut || store.cartLines.isEmpty)

                            if let checkoutError {
                                Text(checkoutError).font(.footnote).foregroundStyle(.red)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Cart").navigationBarTitleDisplayMode(.inline)
        }
    }

    @MainActor
    private func startCheckout() async {
        guard !store.cartLines.isEmpty else { return }
        isCheckingOut = true
        checkoutError = nil
        defer { isCheckingOut = false }

        do {
            let endpoint = URL(string: "https://ocgcustomslab.com/catalog-api/checkout")!
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(CheckoutRequest(items: store.cartLines.map {
                CheckoutItem(id: $0.product.id, quantity: $0.quantity)
            }))

            let (data, response) = try await URLSession.shared.data(for: request)
            let result = try JSONDecoder().decode(CheckoutResponse.self, from: data)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let checkoutURL = result.url else {
                checkoutError = result.error ?? "Stripe checkout could not start. Please try again."
                return
            }
            await UIApplication.shared.open(checkoutURL)
        } catch {
            checkoutError = error.localizedDescription
        }
    }
}
