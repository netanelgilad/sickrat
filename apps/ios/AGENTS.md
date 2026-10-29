# Native iOS design

Use Apple’s Human Interface Guidelines and the installed `swiftui-expert-skill` for iOS UI work. Prefer system type, semantic colors, lists, navigation, and control behavior. Do not apply web-design rules that discourage system fonts or encourage decorative layouts.

- Keep existing content and scroll geometry stable during background refresh.
- `.refreshable` owns the pull-to-refresh indicator. Never add a second refresh banner or spinner.
- Put action progress in the initiating control. Reserve the icon slot so the row does not jump.
- Use compact status rows within populated lists. Use full-page empty states only when the whole screen is empty.
- First-load placeholders should resemble the content and not pretend records already exist.
- Use one meaningful accessible loading description; decorative placeholders must not be announced.
- Before publishing visible changes, inspect screenshots in dark and light appearance and larger Dynamic Type. Check the behavior that triggered the report, not only static screenshots.
- Keep deterministic visual fixtures DEBUG-only and free of user data/network. Run the design UI tests to guard indicator placement and layout stability.
