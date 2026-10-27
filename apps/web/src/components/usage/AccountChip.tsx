import { cn } from "../../lib/utils";

function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function AccountChip({
  email,
  image,
  className,
}: {
  readonly email: string | undefined;
  readonly image: string | undefined;
  readonly className?: string;
}) {
  if (image) {
    return (
      <img
        src={image}
        alt={email ?? "Account"}
        className={cn("size-4 shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  if (!email) return null;
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={`Account ${accountInitials(email)}`}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold",
        className,
      )}
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}
