import WidgetKit
import SwiftUI
import AppIntents
internal import ExpoWidgets

// AppIntent
struct SubscriptionUsageConfigurationAppIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Subscription usage Configuration"
  static var description: LocalizedStringResource = "Both shows Session and Weekly when available. The Lock Screen shows the tightest selected limit."

  @Parameter(title: "Codex limits", default: SubscriptionUsageCodexPeriodEnum.auto)
  var codexPeriod: SubscriptionUsageCodexPeriodEnum
  @Parameter(title: "Claude limits", default: SubscriptionUsageClaudePeriodEnum.auto)
  var claudePeriod: SubscriptionUsageClaudePeriodEnum

  func perform() async throws -> some IntentResult {
    return .result()
  }
}

enum SubscriptionUsageCodexPeriodEnum: String, CaseIterable, AppEnum {
  case auto
  case session
  case weekly

  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Codex limits")

  static var caseDisplayRepresentations: [SubscriptionUsageCodexPeriodEnum: DisplayRepresentation] = [
    .auto: DisplayRepresentation(title: "Both"),
    .session: DisplayRepresentation(title: "Session"),
    .weekly: DisplayRepresentation(title: "Weekly")
  ]
}

enum SubscriptionUsageClaudePeriodEnum: String, CaseIterable, AppEnum {
  case auto
  case session
  case weekly

  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Claude limits")

  static var caseDisplayRepresentations: [SubscriptionUsageClaudePeriodEnum: DisplayRepresentation] = [
    .auto: DisplayRepresentation(title: "Both"),
    .session: DisplayRepresentation(title: "Session"),
    .weekly: DisplayRepresentation(title: "Weekly")
  ]
}

struct SubscriptionUsageTimelineEntry: TimelineEntry {
  let date: Date
  public let name: String
  public let props: [String: Any]?
  public let entryIndex: Int?
  let configuration: SubscriptionUsageConfigurationAppIntent
}

struct SubscriptionUsageTimelineProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> SubscriptionUsageTimelineEntry {
    SubscriptionUsageTimelineEntry(date: Date(), name: "SubscriptionUsage", props: WidgetsLayoutRegistry.initialProps(for: "SubscriptionUsage"), entryIndex: nil, configuration: SubscriptionUsageConfigurationAppIntent())
  }

  func snapshot(for configuration: SubscriptionUsageConfigurationAppIntent, in context: Context) async -> SubscriptionUsageTimelineEntry {
    let entries = parseTimeline(configuration: configuration)
    return entries.first ?? SubscriptionUsageTimelineEntry(date: Date(), name: "SubscriptionUsage", props: WidgetsLayoutRegistry.initialProps(for: "SubscriptionUsage"), entryIndex: nil, configuration: configuration)
  }

  func timeline(for configuration: SubscriptionUsageConfigurationAppIntent, in context: Context) async -> Timeline<SubscriptionUsageTimelineEntry> {
    let entries = self.parseTimeline(configuration: configuration)
    let timeline = Timeline<SubscriptionUsageTimelineEntry>(entries: entries, policy: .atEnd)
    return timeline
  }
  
  func parseTimeline(configuration: SubscriptionUsageConfigurationAppIntent) -> [SubscriptionUsageTimelineEntry] {
    guard let timeline = WidgetsStorage.getArray(forKey: "__expo_widgets_SubscriptionUsage_timeline") else {
      return [SubscriptionUsageTimelineEntry(date: Date(), name: "SubscriptionUsage", props: WidgetsLayoutRegistry.initialProps(for: "SubscriptionUsage"), entryIndex: nil, configuration: configuration)]
    }
    let entries: [SubscriptionUsageTimelineEntry?] = timeline.enumerated().map { index, entry in
      guard let entry = entry as? [String: Any], let timestamp = entry["timestamp"] as? Int, let props = entry["props"] as? [String: Any] else {
        return nil
      }
      return SubscriptionUsageTimelineEntry(
        date: Date(timeIntervalSince1970: Double(timestamp) / 1000),
        name: "SubscriptionUsage",
        props: props,
        entryIndex: index,
        configuration: configuration
      )
    }

    return entries.compactMap(\.self)
  }
}

struct SubscriptionUsageEntryView: View {
  @Environment(\.self) var environment
  var entry: SubscriptionUsageTimelineProvider.Entry

  init(entry: SubscriptionUsageTimelineProvider.Entry) {
    self.entry = entry
  }

  private var widgetEnvironment: [String: Any] {
    var env: [String: Any] = getWidgetEnvironment(environment: environment)
    env["timestamp"] = Int(entry.date.timeIntervalSince1970 * 1000)
    env["configuration"] = [
        "codexPeriod": entry.configuration.codexPeriod.rawValue,
      "claudePeriod": entry.configuration.claudePeriod.rawValue
    ]
    return env
  }

  private var widgetEnvironmentString: String? {
    guard let data = try? JSONSerialization.data(withJSONObject: widgetEnvironment),
          let jsonString = String(data: data, encoding: .utf8) else {
        return nil
    }
    return jsonString
  }

  public var body: some View {
    if let layout = WidgetsLayoutRegistry.layout(for: entry.name) {
      let node = evaluateLayout(layout: layout, props: entry.props, environment: widgetEnvironment)
      WidgetsDynamicView(name: entry.name, kind: .widget, node: node, entryIndex: entry.entryIndex, environmentString: widgetEnvironmentString)
    } else {
      WidgetsDynamicView(name: entry.name, kind: .widget, node: createRedBox(message: "No layout found for \(WidgetsStorage.appGroupIdentifier ?? "")::\(entry.name)"), entryIndex: entry.entryIndex, environmentString: widgetEnvironmentString)
    }
  }
}


@available(iOS 17.0, *)
struct SubscriptionUsage: Widget {
  let name: String = "SubscriptionUsage"

  var body: some WidgetConfiguration {
    return AppIntentConfiguration(kind: name, intent: SubscriptionUsageConfigurationAppIntent.self, provider: SubscriptionUsageTimelineProvider()) { entry in
      SubscriptionUsageEntryView(entry: entry)
    }
    .configurationDisplayName("Subscription usage")
    .description("Subscription quotas from your connected d4research environments.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge, .accessoryRectangular])
  }
}