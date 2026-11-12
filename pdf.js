/* Snaffle - a minimal PDF writer: one JPEG per page, nothing else.

   Used for screenshots saved as PDF, by the capture script in the page and by
   the results page. A capture too tall for one image becomes several pages.

   `var` and the reuse guard are deliberate: this file can be injected into a
   tab more than once. */
var SnafflePdf = (typeof SnafflePdf !== 'undefined' && SnafflePdf) || (function () {
  const MAX_PT = 14400;    // the largest page side the format allows
  const PAGE_PT = 612;     // letter width; height follows the image

  // pages: [{ jpeg: Uint8Array, width, height }] with sizes in pixels.
  // Returns the file as a list of byte chunks, ready for `new Blob(chunks)`.
  // Byte offsets in the cross-reference table have to be exact, so the file is
  // assembled from chunks with a running offset rather than as one string.
  function build(pages) {
    const enc = new TextEncoder();
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      ''                                   // the page tree, filled in below
    ];
    const kids = [];

    for (const p of pages) {
      let ptW = PAGE_PT;
      let ptH = (p.height / p.width) * ptW;
      if (ptH > MAX_PT) { ptH = MAX_PT; ptW = (p.width / p.height) * ptH; }
      const w = ptW.toFixed(2);
      const h = ptH.toFixed(2);

      const pageNo = objects.length + 1;
      const imageNo = pageNo + 1;
      const contentNo = pageNo + 2;
      kids.push(pageNo + ' 0 R');

      // Scale the unit square the image is drawn in up to the whole page.
      const content = enc.encode('q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q\n');
      objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + ']' +
        ' /Resources << /XObject << /Im0 ' + imageNo + ' 0 R >> >> /Contents ' + contentNo + ' 0 R >>');
      objects.push({
        dict: '<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height +
              ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>',
        stream: p.jpeg
      });
      objects.push({ dict: '<< /Length ' + content.length + ' >>', stream: content });
    }
    objects[1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>';

    const chunks = [];
    let offset = 0;
    const push = (bytes) => { chunks.push(bytes); offset += bytes.length; };
    const pushText = (s) => push(enc.encode(s));

    // The second line marks the file as binary for tools that sniff it.
    pushText('%PDF-1.4\n%' + String.fromCharCode(226, 227, 207, 211) + '\n');

    const offsets = [];
    objects.forEach((obj, i) => {
      offsets.push(offset);
      const n = i + 1;
      if (typeof obj === 'string') {
        pushText(n + ' 0 obj\n' + obj + '\nendobj\n');
      } else {
        pushText(n + ' 0 obj\n' + obj.dict + '\nstream\n');
        push(obj.stream);
        pushText('\nendstream\nendobj\n');
      }
    });

    const xref = offset;
    let table = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (const off of offsets) table += String(off).padStart(10, '0') + ' 00000 n \n';
    table += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    pushText(table);

    return chunks;
  }

  return { build };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SnafflePdf;
