import type { HTMLAttributes, Ref } from "react";

// float = capsule near the top, the rest are glued to an edge
export type Edge = "top" | "bottom" | "right" | "left" | "float";

interface Props extends HTMLAttributes<HTMLDivElement> {
  edge: Edge;
  ref?: Ref<HTMLDivElement>;
}

/** Black shape glued to a screen edge, fillets = the inverse corners. */
export function Island({ edge, className, children, ref, ...rest }: Props) {
  return (
    <div ref={ref} className={`island island--${edge}${className ? ` ${className}` : ""}`} {...rest}>
      {edge !== "float" && (
        <>
          <span className="island__fillet island__fillet--a" aria-hidden />
          <span className="island__fillet island__fillet--b" aria-hidden />
        </>
      )}
      <div className="island__body">{children}</div>
    </div>
  );
}
