import { Image, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function emailInitials(email: string) {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase();
}

function accountHue(email: string) {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

// Same hashed hue as the web account chip, so an account keeps its color across clients.
export function AccountChip({
  email,
  image,
}: {
  readonly email: string | undefined;
  readonly image?: string | undefined;
}) {
  if (image) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri: image }}
        className="size-5 rounded-full"
      />
    );
  }
  if (!email) return null;
  const hue = accountHue(email);
  return (
    <View
      className="size-5 items-center justify-center rounded-full"
      style={{ backgroundColor: `hsl(${hue}, 45%, 82%)` }}
    >
      <Text className="text-[9px] font-t3-bold" style={{ color: `hsl(${hue}, 45%, 28%)` }}>
        {emailInitials(email)}
      </Text>
    </View>
  );
}
