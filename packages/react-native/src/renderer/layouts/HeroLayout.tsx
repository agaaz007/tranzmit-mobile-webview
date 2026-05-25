import { View } from "react-native";
import { StackLayout, type LayoutProps } from "./StackLayout.js";

export function HeroLayout(props: LayoutProps) {
  return (
    <View style={{ paddingTop: 8 }}>
      <StackLayout {...props} />
    </View>
  );
}
