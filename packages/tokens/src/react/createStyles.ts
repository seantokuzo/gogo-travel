/**
 * createStyles — the token-consumption factory (R-ds-7, spec §2.7).
 *
 * Declared at module scope, resolved via useTheme() at render:
 *
 *   const useStyles = createStyles((t) =>
 *     StyleSheet.create({            // ← app-side factories may call RN's
 *       container: {                 //   StyleSheet.create INSIDE the factory;
 *         flex: 1,                   //   this package never imports RN — the
 *         backgroundColor: t.color.bg.screen,   // factory returns a generic
 *         padding: t.space[4],       //   styles object of the caller's type
 *       },
 *     }),
 *   );
 *   // in component:
 *   const s = useStyles();
 *
 * The result is cached in a WeakMap<Theme, T>: the factory runs ONCE per
 * theme object, not per render. `getTheme` memoizes Theme per
 * (accent, scheme), so switching back to a previously seen theme reuses the
 * cached styles by reference — components can rely on referential equality.
 */
import type { Theme } from "../types.js";
import { useTheme } from "./context.js";

export function createStyles<T>(factory: (theme: Theme) => T): () => T {
  const cache = new WeakMap<Theme, T>();
  return function useStyles(): T {
    const { theme } = useTheme();
    if (cache.has(theme)) {
      return cache.get(theme) as T;
    }
    const styles = factory(theme);
    cache.set(theme, styles);
    return styles;
  };
}
