import type { HTMLAttributes, Ref } from "react";

export type Edge = "top" | "bottom" | "right";

interface Props extends HTMLAttributes<HTMLDivElement> {
  edge: Edge;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Black shape glued to a screen edge. The two fillets are the inverse corners
 * where it meets the edge, they ride along when the size animates.
 */
export function Island({ edge, className, children, ref, ...rest }: Props) {
  return (
    <div ref={ref} className={`island island--${edge}${className ? ` ${className}` : ""}`} {...rest}>
      <span className="island__fillet island__fillet--a" aria-hidden />
      <span className="island__fillet island__fillet--b" aria-hidden />
      <div className="island__body">{children}</div>
    </div>
  );
}
