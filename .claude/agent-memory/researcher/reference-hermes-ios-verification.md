---
name: reference-hermes-ios-verification
description: How to settle "what does Hermes-on-iOS actually do" questions with real evidence, without a simulator — exact-tag source lookup + a host-Mac Foundation probe
metadata:
  type: reference
---

Two techniques that turn Hermes/iOS runtime questions from inference into evidence, neither of
which needs the simulator (which a sibling agent often owns):

1. **Pin the exact source.** `apps/mobile/node_modules/react-native/sdks/hermes-engine/version.properties`
   gives `HERMES_V1_VERSION_NAME` (RN 0.86 ships **Hermes V1**, framework `hermesvm.framework`, not
   `hermes.framework`). That string maps 1:1 to a real tag:
   `curl https://api.github.com/repos/facebook/hermes/git/ref/tags/hermes-v<version>` → commit sha →
   fetch `lib/Platform/Intl/PlatformIntlApple.mm` at that sha from raw.githubusercontent.com. Never
   read `main` and assume; the Apple Intl file has been disabled and re-enabled more than once.

2. **Probe Foundation on the host Mac.** Hermes' iOS `Intl` is a thin wrapper over `NSDateFormatter` /
   `NSTimeZone` / `NSLocale`, and macOS ships the same Foundation + CLDR. Compile a scratchpad
   `.mm` with `clang++ -fobjc-arc -std=c++20 -framework Foundation` that (a) calls the same Foundation
   APIs Hermes calls and (b) ports the Hermes C++ helper verbatim. That reproduces device behavior
   for everything except iOS-only _user settings_ (e.g. the "24-Hour Time" toggle) — flag those as
   the residual gap rather than claiming full coverage.

Corroboration that is cheap and legitimate: `nm -m` / `otool -L` / `strings` on the shipped
`hermesvm` binary. Note Hermes string literals are `char16_t` — plain `strings` misses them, and BSD
`strings` has no `-e`; scan for UTF-16LE with a short python `re.finditer` instead.

Related: [[gogo-sim-qa-toolkit]] for when you actually do need the simulator.
