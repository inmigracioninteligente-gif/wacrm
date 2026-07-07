import { readFileSync } from "fs";
import { join } from "path";
import { ImageResponse } from "next/og";

// Next.js's static `icon.png` file convention isn't picked up by the
// Turbopack dev server in this Next.js version, so the favicon is
// generated dynamically here instead — reading the same cropped
// brand mark used by the sidebar (`public/logo-mark.png`) and
// re-rendering it at favicon size.

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const logoMarkBase64 = readFileSync(
  join(process.cwd(), "public", "logo-mark.png"),
).toString("base64");

export default function Icon() {
  return new ImageResponse(
    (
      <img
        src={`data:image/png;base64,${logoMarkBase64}`}
        width={size.width}
        height={size.height}
        alt="ParaDesk"
      />
    ),
    { ...size },
  );
}
