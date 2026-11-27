import SwiftUI
import StripePaymentSheet

private struct CheckoutItem: Encodable {
    let id: String
    let quantity: Int
}

private struct ShippingAddress: Codable {
    var name = ""
    var email = ""
    var line1 = ""
    var line2 = ""
    var city = ""
    var state = ""
    var postalCode = ""
    var country = "US"
}

private struct CreatePaymentIntentRequest: Encodable {
    let items: [CheckoutItem]
    let shippingAddress: ShippingAddress
}

private struct CreatePaymentIntentResponse: Decodable {
    let clientSecret: String?
    let publishableKey: String?
    let paymentIntentId: String?
    let amount: Int?
    let error: String?
}

private struct CompletePaymentRequest: Encodable {
    let paymentIntentId: String
}

private struct CompletePaymentResponse: Decodable {
    let recorded: Bool?
    let error: String?
}

struct CartView: View {
    @EnvironmentObject private var store: Store
    @State private var isCheckingOut = false
    @State private var checkoutError: String?
    @State private var isAddressPresented = false
    @State private var paymentSheet: PaymentSheet?
    @State private var successMessage: String?

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
                            LabeledContent("Listed shipping", value: shippingEstimate.formatted(.currency(code: "USD")))
                            LabeledContent("Before tax", value: (store.cartSubtotal + shippingEstimate).formatted(.currency(code: "USD")))
                            Text("Enter your shipping address to calculate any applicable tax. Your exact total appears before you pay.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Section("Payment") {
                            Button {
                                isAddressPresented = true
                            } label: {
                                HStack {
                                    if isCheckingOut { ProgressView().tint(.white) }
                                    Text(isCheckingOut ? "Preparing secure checkout…" : "Continue to secure checkout")
                                    Spacer()
                                    Image(systemName: "lock.fill")
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
            .sheet(isPresented: $isAddressPresented) {
                ShippingAddressForm(isLoading: isCheckingOut) { address in
                    isAddressPresented = false
                    Task { await startCheckout(address: address) }
                }
            }
            .alert("Payment complete", isPresented: Binding(
                get: { successMessage != nil }, set: { if !$0 { successMessage = nil } }
            )) {
                Button("OK") { successMessage = nil }
            } message: {
                Text(successMessage ?? "Your order was paid successfully.")
            }
        }
    }

    private var shippingEstimate: Double {
        store.cartLines.reduce(0) { $0 + $1.product.shipping * Double($1.quantity) }
    }

    @MainActor
    private func startCheckout(address: ShippingAddress) async {
        guard !store.cartLines.isEmpty else { return }
        isCheckingOut = true
        checkoutError = nil
        defer { isCheckingOut = false }

        do {
            let endpoint = URL(string: "https://ocgcustomslab.com/catalog-api/checkout/intent")!
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(CreatePaymentIntentRequest(
                items: store.cartLines.map { CheckoutItem(id: $0.product.id, quantity: $0.quantity) },
                shippingAddress: address
            ))

            let (data, response) = try await URLSession.shared.data(for: request)
            let result = try JSONDecoder().decode(CreatePaymentIntentResponse.self, from: data)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let clientSecret = result.clientSecret,
                  let publishableKey = result.publishableKey,
                  let paymentIntentId = result.paymentIntentId else {
                checkoutError = result.error ?? "Secure checkout could not start. Please try again."
                return
            }

            StripeAPI.defaultPublishableKey = publishableKey
            var configuration = PaymentSheet.Configuration()
            configuration.merchantDisplayName = "OCG Custom Slab"
            configuration.allowsDelayedPaymentMethods = false
            paymentSheet = PaymentSheet(paymentIntentClientSecret: clientSecret, configuration: configuration)
            guard let paymentSheet, let presenter = UIApplication.shared.ocgTopViewController else {
                checkoutError = "The in-app payment screen could not be opened. Please try again."
                return
            }
            paymentSheet.present(from: presenter) { result in
                switch result {
                case .completed:
                    Task { await recordCompletedPayment(paymentIntentId) }
                case .canceled:
                    break
                case .failed(let error):
                    checkoutError = error.localizedDescription
                }
            }
        } catch {
            checkoutError = error.localizedDescription
        }
    }

    @MainActor
    private func recordCompletedPayment(_ paymentIntentId: String) async {
        do {
            let endpoint = URL(string: "https://ocgcustomslab.com/catalog-api/checkout/complete")!
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(CompletePaymentRequest(paymentIntentId: paymentIntentId))
            let (data, response) = try await URLSession.shared.data(for: request)
            let result = try JSONDecoder().decode(CompletePaymentResponse.self, from: data)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode), result.recorded == true else {
                checkoutError = result.error ?? "Payment succeeded, but order confirmation is still processing. Please contact OCG before trying again."
                return
            }
            store.clearCart()
            successMessage = "Thank you. Your payment and order were confirmed."
        } catch {
            checkoutError = "Payment succeeded, but order confirmation is still processing. Please contact OCG before trying again."
        }
    }
}

private struct ShippingAddressForm: View {
    @Environment(\.dismiss) private var dismiss
    @State private var address = ShippingAddress()
    let isLoading: Bool
    let onContinue: (ShippingAddress) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Shipping address") {
                    TextField("Full name", text: $address.name)
                        .textContentType(.name)
                        .textInputAutocapitalization(.words)
                    TextField("Email", text: $address.email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Street address", text: $address.line1)
                        .textContentType(.streetAddressLine1)
                        .textInputAutocapitalization(.words)
                    TextField("Apt, suite, etc. (optional)", text: $address.line2)
                        .textContentType(.streetAddressLine2)
                    TextField("City", text: $address.city)
                        .textContentType(.addressCity)
                        .textInputAutocapitalization(.words)
                    TextField("State (e.g. IL)", text: $address.state)
                        .textContentType(.addressState)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    TextField("ZIP code", text: $address.postalCode)
                        .textContentType(.postalCode)
                        .keyboardType(.numbersAndPunctuation)
                    LabeledContent("Country", value: "United States")
                }
                Section {
                    Text("We use this address to calculate any applicable sales tax and delivery total before payment.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Shipping")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isLoading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Continue") { onContinue(address) }
                        .disabled(isLoading || !isValid)
                }
            }
        }
    }

    private var isValid: Bool {
        address.name.trimmingCharacters(in: .whitespacesAndNewlines).count > 1 &&
        address.email.contains("@") && address.line1.trimmingCharacters(in: .whitespacesAndNewlines).count > 3 &&
        !address.city.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        address.state.trimmingCharacters(in: .whitespacesAndNewlines).count == 2 &&
        address.postalCode.trimmingCharacters(in: .whitespacesAndNewlines).count >= 5
    }
}

private extension UIApplication {
    var ocgTopViewController: UIViewController? {
        let root = connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?.rootViewController
        return Self.topViewController(from: root)
    }

    static func topViewController(from controller: UIViewController?) -> UIViewController? {
        if let presented = controller?.presentedViewController {
            return topViewController(from: presented)
        }
        if let navigation = controller as? UINavigationController {
            return topViewController(from: navigation.visibleViewController)
        }
        if let tabs = controller as? UITabBarController {
            return topViewController(from: tabs.selectedViewController)
        }
        return controller
    }
}
