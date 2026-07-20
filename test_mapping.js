const record = {
  analysis: {
    documents: [
      { id: "published_material_about_applicant", category: "evidence", fileName: "Exhibit_17.pdf" },
      { id: "leading_critical_role", category: "evidence", fileName: "Exhibit_17.pdf" },
      { id: "published_material_about_applicant", category: "evidence", fileName: "Research_Wired_UK.pdf" },
      { id: "leading_critical_role", category: "evidence", fileName: "Research_Founders.pdf" }
    ],
    evidence: [
      { category: "published_material_about_applicant", file_name: "Research_Wired_UK.pdf" },
      { category: "leading_critical_role", file_name: "Research_Founders.pdf" }
    ]
  }
};

const getExhibitMapping = (record) => {
  const allDocs = [
    ...(record.analysis.documents || []),
    ...(record.analysis.evidence || []).map((e) => ({
       ...e,
       label: e.type || e.file_name,
       fileName: e.file_name,
       status: 'provided'
    }))
  ];

  const categoryToLetter = new Map();
  const categoryCounters = new Map();
  let currentLetterCode = 65; // 'A'

  return allDocs.map((doc) => {
    const cat = doc.category || 'uncategorized';
    if (!categoryToLetter.has(cat)) {
      categoryToLetter.set(cat, String.fromCharCode(currentLetterCode));
      currentLetterCode++;
    }
    const letter = categoryToLetter.get(cat);
    const count = (categoryCounters.get(cat) || 0) + 1;
    categoryCounters.set(cat, count);
    
    return {
      ...doc,
      exhibitLetter: letter,
      exhibitNumber: `Exhibit ${letter}-${count}`
    };
  });
};

const mappedExhibits = getExhibitMapping(record);
console.log(mappedExhibits);
