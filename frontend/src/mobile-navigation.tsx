import { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';

export function MobileNavigation<T extends string>({
  items,
  active,
  manager,
  poolCount,
  onNavigate,
}: {
  items: { id: T; label: string; icon: LucideIcon }[];
  active: T;
  manager: boolean;
  poolCount: number;
  onNavigate: (page: T) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = ref.current;
    const button = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && button)
      nav.scrollTo({
        left: button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2,
        behavior: 'auto',
      });
  }, [active]);
  return (
    <nav
      ref={ref}
      className={`mobile-bottom-nav ${manager ? 'management-nav' : ''}`}
      aria-label={manager ? 'Atalhos de gestão' : 'Atalhos de atendimento'}
    >
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          aria-label={id === 'pipeline' ? 'Funil de vendas' : label}
          className={active === id ? 'active' : ''}
          aria-current={active === id ? 'page' : undefined}
          onClick={() => onNavigate(id)}
        >
          <span className="mobile-nav-icon">
            <Icon size={22} />
            {(id === 'pool' || id === 'distribution') && poolCount > 0 && (
              <b aria-label={`${poolCount} no bolsão`}>{poolCount > 99 ? '99+' : poolCount}</b>
            )}
          </span>
          <span>{id === 'pipeline' ? 'Funil' : id === 'central' ? 'Central' : label}</span>
        </button>
      ))}
    </nav>
  );
}
