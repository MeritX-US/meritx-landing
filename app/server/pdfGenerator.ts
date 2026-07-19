import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs';

export async function generateResearchPDF(title: string, markdownContent: string, outputPath: string): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();
  const margin = 50;
  const maxWidth = width - 2 * margin;
  let y = height - margin;

  const lines = markdownContent.split('\n');

  const drawLine = (text: string, currentFont: any, size: number, color: any = rgb(0,0,0)) => {
    // Strip markdown bold asterisks for clean text rendering
    const cleanText = text.replace(/\*\*/g, '');
    const words = cleanText.split(' ');
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine + word + ' ';
      const textWidth = currentFont.widthOfTextAtSize(testLine, size);
      
      if (textWidth > maxWidth && currentLine !== '') {
        if (y < margin) {
          page = pdfDoc.addPage();
          y = height - margin;
        }
        page.drawText(currentLine.trim(), { x: margin, y, size, font: currentFont, color });
        y -= (size + 5);
        currentLine = word + ' ';
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine.trim() !== '') {
      if (y < margin) {
        page = pdfDoc.addPage();
        y = height - margin;
      }
      page.drawText(currentLine.trim(), { x: margin, y, size, font: currentFont, color });
      y -= (size + 5);
    }
  };

  // Add Title
  drawLine(`Research Report`, boldFont, 18, rgb(0, 0, 0.5));
  y -= 10;

  for (const line of lines) {
    if (line.trim() === '') {
      y -= 10;
      continue;
    }
    
    if (line.startsWith('# ')) {
      y -= 5;
      drawLine(line.replace('# ', ''), boldFont, 16);
    } else if (line.startsWith('## ')) {
      y -= 5;
      drawLine(line.replace('## ', ''), boldFont, 14);
    } else if (line.startsWith('### ')) {
      drawLine(line.replace('### ', ''), boldFont, 12);
    } else if (line.startsWith('- ')) {
      drawLine('  • ' + line.substring(2), font, 11);
    } else {
      drawLine(line, font, 11);
    }
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
}
