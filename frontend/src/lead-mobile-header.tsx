import { useEffect, useRef } from 'react';
import { ArrowLeft, MoreHorizontal, MessageCircle, Copy, Save } from 'lucide-react';

export function LeadMobileHeader({
  name,
  formId,
  editable,
  canConverse,
  connected,
  saving,
  hasSale,
  copied,
  onClose,
  onConversation,
  onCopy,
  onSale,
}: {
  name: string;
  formId: string;
  editable: boolean;
  canConverse: boolean;
  connected: boolean;
  saving: boolean;
  hasSale: boolean;
  copied: boolean;
  onClose: () => void;
  onConversation: () => void;
  onCopy: () => void;
  onSale: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => menu.current?.removeAttribute('open');
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return (
    <div className="lead-mobile-toolbar">
      <button
        type="button"
        className="icon-button"
        aria-label="Voltar da ficha do lead"
        disabled={saving}
        onClick={onClose}
      >
        <ArrowLeft size={22} />
      </button>
      <strong className="lead-mobile-title">
        <span className="lead-normal-title">Ficha do lead</span>
        <span className="lead-keyboard-title">{name}</span>
      </strong>
      {editable && (
        <button
          type="submit"
          form={formId}
          formNoValidate
          className="lead-keyboard-save"
          disabled={!connected || saving}
          aria-label="Salvar cadastro"
        >
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
      )}
      {editable && (
        <details
          ref={menu}
          className="lead-mobile-menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && menu.current?.open) {
              event.preventDefault();
              event.stopPropagation();
              closeMenu();
              menu.current.querySelector('summary')?.focus();
            }
          }}
        >
          <summary aria-label="Mais ações do lead">
            <MoreHorizontal size={23} />
          </summary>
          <div className="lead-mobile-menu-panel" role="group" aria-label="Ações do lead">
            {canConverse && (
              <button
                type="button"
                disabled={!connected || saving}
                onClick={() => {
                  closeMenu();
                  onConversation();
                }}
              >
                <MessageCircle size={18} />
                Abrir conversa
              </button>
            )}
            <button
              type="button"
              disabled={!hasSale || saving}
              onClick={() => {
                closeMenu();
                onCopy();
              }}
            >
              <Copy size={18} />
              {copied ? 'Copiado!' : 'Copiar para WhatsApp'}
            </button>
            <button
              type="button"
              disabled={!connected || saving}
              onClick={() => {
                closeMenu();
                onSale();
              }}
            >
              <Save size={18} />
              {hasSale ? 'Atualizar venda' : 'Registrar venda'}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
