/** 产品 logo 标识(青柠 G · 洞察轨道):透明底 PNG,深色/浅色界面通用。 */
export function LogoMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <img src="/logo.png" alt="青柠GEO" draggable={false} className={className} />
  );
}
