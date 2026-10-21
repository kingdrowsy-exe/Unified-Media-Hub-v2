interface TileProps {
  image?: string;
  title: string;
  genre?: string;
  ratingPercent?: number;
  year?: number;
  badges?: string[];
  owned?: boolean;
  shape?: "poster" | "wide";
  onClick: () => void;
}

export default function Tile({
  image,
  title,
  genre,
  ratingPercent,
  year,
  badges,
  owned = true,
  shape = "poster",
  onClick,
}: TileProps) {
  const metaParts: string[] = [];
  if (genre) metaParts.push(genre);
  if (year) metaParts.push(String(year));

  return (
    <button type="button" className={`tile ${owned ? "" : "tile-unowned"}`} onClick={onClick}>
      <div className={`tile-art ${shape}`}>
        {image ? <img src={image} alt="" loading="lazy" /> : <div className="tile-art-empty" />}
      </div>
      {(metaParts.length > 0 || ratingPercent !== undefined) && (
        <div className="tile-meta">
          {metaParts.join(" • ")}
          {metaParts.length > 0 && ratingPercent !== undefined && " • "}
          {ratingPercent !== undefined && <span className="tile-rating">★ {ratingPercent}%</span>}
        </div>
      )}
      <div className="tile-title">{title}</div>
      {!owned ? (
        <div className="tile-subtitle">
          <span className="badge badge-unowned">Not in library</span>
        </div>
      ) : (
        badges &&
        badges.length > 0 && (
          <div className="tile-subtitle">
            {badges.map((b) => (
              <span className={`badge badge-${b}`} key={b}>
                {b}
              </span>
            ))}
          </div>
        )
      )}
    </button>
  );
}
