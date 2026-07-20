const record = {
  items: [
    { name: 'Research_Wired_UK.pdf', url: '/uploads/Research_Wired_UK.pdf' },
    { name: 'Exhibit_17_Exhibit_17___Wired_UK___Highlights_from_Founders_of_the_Future_Forum.pdf', url: '/uploads/1784504734354-757067736.pdf' }
  ],
  analysis: {
    documents: [
      { fileName: 'Research_Wired_UK.pdf', id: 'published_material_about_applicant', status: 'provided' }
    ]
  }
};

const doc = record.analysis.documents[0];
const physicalItem = record.items?.find((i: any) => i.name === doc.fileName || i.file_name === doc.fileName || (doc.fileName && i.name && doc.fileName.includes(i.name)));

console.log('physicalItem found:', physicalItem);
if (physicalItem && physicalItem.url) {
  console.log('Would render <a> tag with url:', physicalItem.url);
} else {
  console.log('Would render doc.fileName plain text');
}
