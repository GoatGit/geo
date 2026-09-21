/** 产品 logo 标识(格尺 G · 六边形格尺):透明底 PNG,深色/浅色界面通用。 */
export function LogoMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <img src="/logo.png" alt="格尺GEO" draggable={false} className={className} />
  );
}
