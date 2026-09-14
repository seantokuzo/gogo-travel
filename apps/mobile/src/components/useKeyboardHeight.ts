/**
 * Live keyboard height in points (0 when hidden) — B-26 R1 (round-1 review
 * B2). Mirrors RN's own `KeyboardAvoidingView` event choice exactly (read at
 * the pinned RN 0.86.2 `Libraries/Components/Keyboard/KeyboardAvoidingView.js`
 * `componentDidMount`): iOS listens to the WILL events (matching the
 * avoider's own `padding` timing), Android to the DID events (iOS has no
 * reliable DID timing pre-animation; Android emits no WILL events at all).
 */
import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setHeight(event.endCoordinates.height);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return height;
}
