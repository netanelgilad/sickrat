import Foundation

enum OwnerRoute: Equatable {
  case home
  case approval(String)
  case devices(String?)
  case connect(provider: String, name: String)
  case connection(String)

  static func parse(_ url: URL, origin: String) -> OwnerRoute? {
    guard url.scheme == "sickrat", url.host == "open", url.user == nil, url.password == nil,
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      items.filter({ $0.name == "origin" }).count == 1,
      items.first(where: { $0.name == "origin" })?.value == origin,
      items.filter({ $0.name == "path" }).count == 1,
      let path = items.first(where: { $0.name == "path" })?.value,
      path.hasPrefix("/"), !path.hasPrefix("//"),
      let target = URLComponents(string: "https://route.invalid" + path), target.host == "route.invalid"
    else { return nil }
    let parts = target.path.split(separator: "/").map(String.init)
    if parts.isEmpty { return .home }
    if parts.count == 2, parts[0] == "approve", UUID(uuidString: parts[1]) != nil { return .approval(parts[1]) }
    if parts == ["devices"] { return .devices(nil) }
    if parts.count == 3, parts[0] == "connections", parts[1] == "providers",
      OAuthPolicy.validName(parts[2]),
      let name = target.queryItems?.first(where: { $0.name == "name" })?.value,
      OAuthPolicy.validName(name) { return .connect(provider: parts[2], name: name) }
    if parts.count == 2, parts[0] == "connections", UUID(uuidString: parts[1]) != nil { return .connection(parts[1]) }
    return nil
  }
}
