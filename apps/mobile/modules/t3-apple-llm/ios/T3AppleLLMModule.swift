import ExpoModulesCore
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

struct T3AppleLLMMessage: Record {
  @Field var role: String = "user"
  @Field var content: String = ""
}

struct T3AppleLLMOptions: Record {
  @Field var maxTokens: Int = 1600
  @Field var temperature: Double = 0.2
}

// Streams cumulative response snapshots as onStreamUpdate events, keyed by the id generateStream returns.
public final class T3AppleLLMModule: Module {
  private let lock = NSLock()
  private var streams: [String: Task<Void, Never>] = [:]

  public func definition() -> ModuleDefinition {
    Name("T3AppleLLM")
    Events("onStreamUpdate", "onStreamComplete", "onStreamError")

    Function("isAvailable") { () -> Bool in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        if case .available = SystemLanguageModel.default.availability { return true }
      }
      #endif
      return false
    }

    Function("generateStream") { (messages: [T3AppleLLMMessage], options: T3AppleLLMOptions) throws -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        let id = UUID().uuidString
        let task = Task { [weak self] in
          await self?.stream(id: id, messages: messages, options: options)
        }
        self.lock.withLock { self.streams[id] = task }
        return id
      }
      #endif
      throw Exception(name: "T3AppleLLMUnavailable", description: "Apple Intelligence requires iOS 26 or later.")
    }

    Function("cancelStream") { (id: String) in
      self.removeStream(id)?.cancel()
    }

    OnDestroy {
      self.lock.withLock {
        self.streams.values.forEach { $0.cancel() }
        self.streams.removeAll()
      }
    }
  }

  private func removeStream(_ id: String) -> Task<Void, Never>? {
    lock.withLock { streams.removeValue(forKey: id) }
  }

  #if canImport(FoundationModels)
  @available(iOS 26.0, *)
  private func stream(id: String, messages: [T3AppleLLMMessage], options: T3AppleLLMOptions) async {
    // Foundation Models takes one instruction block and one prompt, so earlier turns are flattened into the prompt.
    let instructions = messages.filter { $0.role == "system" }.map(\.content).joined(separator: "\n\n")
    let prompt = messages
      .filter { $0.role != "system" }
      .map { "\($0.role == "assistant" ? "Assistant" : "User"): \($0.content)" }
      .joined(separator: "\n\n")
    let session = LanguageModelSession(instructions: instructions)
    let generation = GenerationOptions(temperature: options.temperature, maximumResponseTokens: options.maxTokens)
    do {
      for try await snapshot in session.streamResponse(to: prompt, options: generation) {
        try Task.checkCancellation()
        sendEvent("onStreamUpdate", ["streamId": id, "content": snapshot.content])
      }
      try Task.checkCancellation()
      sendEvent("onStreamComplete", ["streamId": id])
    } catch is CancellationError {
      // cancelStream already removed the stream; the JavaScript caller rejected on abort.
    } catch {
      sendEvent("onStreamError", ["streamId": id, "error": String(describing: error)])
    }
    _ = removeStream(id)
  }
  #endif
}
