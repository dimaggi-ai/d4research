#import <Foundation/Foundation.h>

// UserNotifications and UIKit value types, declared in Objective-C so the stub delegate protocol
// can keep the SDK's optional @objc requirements.
typedef NS_OPTIONS(NSUInteger, UNNotificationPresentationOptions) {
  UNNotificationPresentationOptionBanner = 1 << 4,
};

typedef NS_ENUM(NSUInteger, UIBackgroundFetchResult) {
  UIBackgroundFetchResultNewData,
  UIBackgroundFetchResultNoData,
  UIBackgroundFetchResultFailed,
};
