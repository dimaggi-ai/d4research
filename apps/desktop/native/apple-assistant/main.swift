import Foundation
import FoundationModels

struct Request: Decodable { let instructions: String; let input: String }
struct Reply: Encodable { var available: Bool; var text: String?; var error: String? }
@main struct AppleAssistant {
  static func main() async {
    var reply = Reply(available: false)
    if #available(macOS 26.0, *) {
      let model = SystemLanguageModel.default
      if case .available = model.availability {
        reply.available = true
        if CommandLine.arguments.contains("--generate") {
          do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 16_384 else { throw AssistantError.tooLarge }
            let request = try JSONDecoder().decode(Request.self, from: data)
            let session = LanguageModelSession(model: model, instructions: request.instructions)
            reply.text = try await session.respond(to: request.input, options: GenerationOptions(sampling: .greedy, maximumResponseTokens: 1200)).content
          } catch {
            reply.error = "The on-device model could not complete this request. Try a shorter excerpt or a supported language."
          }
        }
      } else {
        reply.error = "Apple Intelligence is unavailable. Enable it in System Settings on a supported Mac."
      }
    } else {
      reply.error = "On-device assistance requires macOS 26 or later."
    }
    if let data = try? JSONEncoder().encode(reply) { FileHandle.standardOutput.write(data) }
  }
  enum AssistantError: Error { case tooLarge }
}
