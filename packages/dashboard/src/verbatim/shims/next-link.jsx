// Thin adapter for `next/link`: a plain anchor (Next-only props dropped).
export default function Link({ href, prefetch, replace, scroll, shallow, passHref, legacyBehavior, ...rest }) {
  return <a href={typeof href === 'string' ? href : href?.pathname ?? '#'} {...rest} />;
}
