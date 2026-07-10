import { StyleSheet, Text, View } from "react-native";

export default function Index() {
  return (
    <View style={styles.container} testID="home-screen">
      <Text style={styles.title} testID="home-title">
        GoGo Travel
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
  },
});
