const mappedExhibits = [
  { fileName: 'Exhibit_17_Exhibit_17___Wired_UK___Highlights_from_Founders_of_the_Future_Forum.pdf', exhibitNumber: 'Exhibit A-1' },
  { fileName: 'Exhibit_17_Exhibit_17___Wired_UK___Highlights_from_Founders_of_the_Future_Forum.pdf', exhibitNumber: 'Exhibit A-2' },
  { fileName: 'Research_Wired_UK.pdf', exhibitNumber: 'Exhibit A-3' },
  { fileName: 'Research_Founders_of_the_Future_Forum.pdf', exhibitNumber: 'Exhibit A-4' }
];

const items = [
  { name: 'Ntiruhungwa_Wired_Coverage.pdf' },
  { name: 'Research_Wired_UK.pdf' },
  { name: 'Research_Founders_of_the_Future_Forum.pdf' }
];

for (const item of items) {
  const mappedEx = mappedExhibits.find(e => e.fileName === item.name || e.fileName === item.name || (e.fileName && item.name && e.fileName.includes(item.name)));
  const exName = mappedEx ? mappedEx.exhibitNumber : `Exhibit X`;
  console.log(`   ${exName}: ${item.name}`);
}
