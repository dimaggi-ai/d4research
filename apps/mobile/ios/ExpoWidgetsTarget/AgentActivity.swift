import WidgetKit
import SwiftUI
internal import ExpoWidgets

struct AgentActivity: Widget {
  let name: String = "AgentActivity"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: name, provider: WidgetsTimelineProvider(name: name)) { entry in
      WidgetsEntryView(entry: entry)
    }
    .configurationDisplayName("Agent Activity")
    .description("Shows the current state of active T3 Code agents.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
  }
}