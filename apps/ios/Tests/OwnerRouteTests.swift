import XCTest
@testable import Sickrat

final class OwnerRouteTests: XCTestCase {
  func link(_ path: String, origin: String = "https://vault.example") -> URL {
    var url = URLComponents(string: "sickrat://open")!
    url.queryItems = [URLQueryItem(name: "origin", value: origin), URLQueryItem(name: "path", value: path)]
    return url.url!
  }
  func testOnlyRoutesForConnectedVault() {
    let id = "550e8400-e29b-41d4-a716-446655440000"
    XCTAssertEqual(OwnerRoute.parse(link("/approve/\(id)"), origin: "https://vault.example"), .approval(id))
    XCTAssertEqual(OwnerRoute.parse(link("/connections/providers/x?name=personal"), origin: "https://vault.example"), .connect(provider: "x", name: "personal"))
    XCTAssertNil(OwnerRoute.parse(link("/devices", origin: "https://other.example"), origin: "https://vault.example"))
    XCTAssertNil(OwnerRoute.parse(link("//other.example/devices"), origin: "https://vault.example"))
    XCTAssertNil(OwnerRoute.parse(link("/approve/invalid"), origin: "https://vault.example"))
    XCTAssertNil(OwnerRoute.parse(link("/connections/providers/x?name=Personal"), origin: "https://vault.example"))
  }
}
