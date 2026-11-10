import { useEffect, useRef, useState } from "react"
import { addPropertyControls, ControlType } from "framer"

/* =====================================================================
   DrainageAnalyst — Framer code component for apollodevelopment.io
   Embeds the Drainage Analyst app (GitHub Pages) and sizes itself to the
   app's content height, so the page scrolls naturally with no inner
   scrollbar. Set the component's height to "Fit content" in Framer when
   Auto height is on.
   ===================================================================== */

type Props = {
    url: string
    theme: "auto" | "dark" | "light"
    autoHeight: boolean
    minHeight: number
    radius: number
    style?: React.CSSProperties
}

export default function DrainageAnalyst({ url, theme, autoHeight, minHeight, radius, style }: Props) {
    const frame = useRef<HTMLIFrameElement>(null)
    const [h, setH] = useState(minHeight)

    useEffect(() => {
        if (!autoHeight) return
        const onMsg = (e: MessageEvent) => {
            if (e.source !== frame.current?.contentWindow) return
            const d = e.data
            if (d && d.type === "apollo-drainage:height" && typeof d.height === "number")
                setH(Math.max(minHeight, Math.ceil(d.height)))
        }
        window.addEventListener("message", onMsg)
        return () => window.removeEventListener("message", onMsg)
    }, [autoHeight, minHeight])

    const src = (() => {
        try {
            const u = new URL(url)
            u.searchParams.set("embed", "1")
            if (theme !== "auto") u.searchParams.set("theme", theme)
            return u.toString()
        } catch {
            return url
        }
    })()

    return (
        <iframe
            ref={frame}
            src={src}
            title="Apollo Drainage Analyst"
            allow="clipboard-write; fullscreen"
            loading="lazy"
            style={{
                width: "100%",
                height: autoHeight ? h : "100%",
                minHeight,
                border: 0,
                borderRadius: radius,
                display: "block",
                background: "transparent",
                ...style,
            }}
        />
    )
}

DrainageAnalyst.defaultProps = {
    url: "https://rchase-sudo.github.io/drainage-analyst/",
    theme: "auto",
    autoHeight: true,
    minHeight: 900,
    radius: 0,
}

addPropertyControls(DrainageAnalyst, {
    url: { type: ControlType.String, title: "App URL" },
    theme: {
        type: ControlType.Enum,
        title: "Theme",
        options: ["auto", "dark", "light"],
        optionTitles: ["Auto", "Dark", "Light"],
    },
    autoHeight: { type: ControlType.Boolean, title: "Auto height", defaultValue: true },
    minHeight: { type: ControlType.Number, title: "Min height", min: 400, max: 3000, step: 10, unit: "px" },
    radius: { type: ControlType.Number, title: "Radius", min: 0, max: 40, unit: "px" },
})
