export function formatDistanceMetres(metres: number) {
  return metres < 1000
    ? `${metres.toFixed(0)} m`
    : `${(metres / 1000).toFixed(2)} km`;
}
