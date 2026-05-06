(function () {
  function escapeAttr(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function slugCompartirPropiedad(texto) {
    return String(texto || 'propiedad')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70) || 'propiedad';
  }

  function precioCompartirPropiedad(p) {
    const sym = p?.moneda === 'USD' ? '$' : 'Q';
    const num = Number(p?.precio || 0).toLocaleString('es-GT');
    return `${sym}${num}${p?.operacion === 'renta' ? '/mes' : ''}`;
  }

  function textoCompartirPropiedad(titulo, precio, ubicacion) {
    return `Mira esta propiedad en InmobIA: ${titulo}${precio ? ` - ${precio}` : ''}${ubicacion ? ` - ${ubicacion}` : ''}`;
  }

  function crearUrlCompartirPropiedad(p, origin = window.location.origin) {
    const shareSlug = `${slugCompartirPropiedad(`${p?.titulo || 'propiedad'} ${p?.nombre_proyecto || ''}`)}-${Date.now()}`;
    return new URL(`/propiedad/${shareSlug}/${p?.id}?shared=whatsapp`, origin).href;
  }

  function crearUrlWhatsappPropiedad(p, origin = window.location.origin) {
    return new URL(`/propiedad.html?id=${p?.id}&s=${Date.now()}`, origin).href;
  }

  function refrescarUrlCompartir(baseUrl) {
    try {
      const url = new URL(baseUrl, window.location.origin);
      const partes = url.pathname.split('/').filter(Boolean);

      if (partes[0] === 'propiedad' && partes.length >= 3) {
        const slugBase = partes[1].replace(/-\d+$/, '');
        partes[1] = `${slugBase}-${Date.now()}`;
        url.pathname = `/${partes.join('/')}`;
        return url.href;
      }

      url.searchParams.set('s', Date.now());
      return url.href;
    } catch (_) {
      return String(baseUrl || '');
    }
  }

  function refrescarUrlWhatsapp(baseUrl) {
    try {
      const url = new URL(baseUrl, window.location.origin);
      url.searchParams.set('s', Date.now());
      return url.href;
    } catch (_) {
      return String(baseUrl || '');
    }
  }

  function cerrarMenusCompartir() {
    document.querySelectorAll('.property-share.open').forEach(el => el.classList.remove('open'));
  }

  function toggleMenuCompartir(event, btn) {
    event.preventDefault();
    event.stopPropagation();
    const wrap = btn.closest('.property-share');
    const estabaAbierto = wrap.classList.contains('open');
    cerrarMenusCompartir();
    if (!estabaAbierto) wrap.classList.add('open');
  }

  async function copiarTexto(texto) {
    try {
      await navigator.clipboard.writeText(texto);
    } catch (_) {
      const tmp = document.createElement('input');
      tmp.value = texto;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      tmp.remove();
    }
  }

  async function compartirPropiedad(event, accion, btn) {
    event.preventDefault();
    event.stopPropagation();
    const wrap = btn.closest('.property-share');
    const baseUrl = wrap.dataset.url;
    const baseWhatsappUrl = wrap.dataset.whatsappUrl || baseUrl;
    const url = accion === 'whatsapp'
      ? refrescarUrlWhatsapp(baseWhatsappUrl)
      : refrescarUrlCompartir(baseUrl);
    const titulo = wrap.dataset.title;
    const texto = wrap.dataset.text;
    const shareText = `${texto}\n${url}`;

    if (accion === 'native' && navigator.share) {
      try {
        await navigator.share({ title: titulo, text: texto, url });
      } catch (_) {}
      cerrarMenusCompartir();
      return;
    }

    if (accion === 'copy') {
      await copiarTexto(url);
      cerrarMenusCompartir();
      return;
    }

    const encodedUrl = encodeURIComponent(url);
    const encodedText = encodeURIComponent(shareText);
    const esMovil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    const destinos = {
      whatsapp: esMovil ? `whatsapp://send?text=${encodedText}` : `https://wa.me/?text=${encodedText}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
      telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodeURIComponent(texto)}`
    };

    if (destinos[accion]) window.open(destinos[accion], '_blank', 'noopener,noreferrer');
    cerrarMenusCompartir();
  }

  window.InmobiaShare = {
    escapeAttr,
    slugCompartirPropiedad,
    precioCompartirPropiedad,
    textoCompartirPropiedad,
    crearUrlCompartirPropiedad,
    crearUrlWhatsappPropiedad,
    refrescarUrlCompartir,
    refrescarUrlWhatsapp,
    cerrarMenusCompartir,
    toggleMenuCompartir,
    compartirPropiedad
  };

  window.escapeAttr = window.escapeAttr || escapeAttr;
  window.slugCompartirPropiedad = window.slugCompartirPropiedad || slugCompartirPropiedad;
  window.precioCompartirPropiedad = window.precioCompartirPropiedad || precioCompartirPropiedad;
  window.textoCompartirPropiedad = window.textoCompartirPropiedad || textoCompartirPropiedad;
  window.cerrarMenusCompartir = window.cerrarMenusCompartir || cerrarMenusCompartir;
  window.toggleMenuCompartir = window.toggleMenuCompartir || toggleMenuCompartir;
  window.compartirPropiedad = window.compartirPropiedad || compartirPropiedad;
})();
