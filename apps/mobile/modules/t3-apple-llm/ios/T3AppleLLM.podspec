Pod::Spec.new do |s|
  s.name           = 'T3AppleLLM'
  s.version        = '1.0.0'
  s.summary        = 'Apple Intelligence on-device model bridge for d4research mobile.'
  s.description    = 'Streams responses from the Foundation Models framework on iOS 26 and later.'
  s.author         = 'DIMAGGI AI'
  s.homepage       = 'https://dimaggi.ai'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # The app still launches on iOS 18, where FoundationModels does not exist.
  s.weak_frameworks = 'FoundationModels'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.swift'
end
