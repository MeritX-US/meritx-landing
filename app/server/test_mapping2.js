const record = {
  analysis: {
    evidence: [
      {
        "category": "eb1a_criteria",
        "type": "awards_prizes",
        "fileName": "KCL_SoyoyeScholarship_2018.pdf",
        "strength": "high"
      }
    ]
  }
};

const allDocs = [
  ...(record.analysis.evidence || []).map((e) => ({
     ...e,
     label: e.type || e.file_name || e.fileName,
     fileName: e.file_name || e.fileName,
     status: 'provided'
  }))
];

const categoryToLetter = new Map();
const categoryCounters = new Map();
let currentLetterCode = 65; // 'A'

const assignedExhibitNumbers = new Map();

const mappedExhibits = allDocs.map((doc) => {
  if (doc.fileName && assignedExhibitNumbers.has(doc.fileName)) {
      const assigned = assignedExhibitNumbers.get(doc.fileName);
      return {
          ...doc,
          exhibitLetter: assigned.letter,
          exhibitNumber: assigned.number
      };
  }

  const cat = doc.category || 'uncategorized';
  if (!categoryToLetter.has(cat)) {
    categoryToLetter.set(cat, String.fromCharCode(currentLetterCode));
    currentLetterCode++;
  }
  const letter = categoryToLetter.get(cat);
  const count = (categoryCounters.get(cat) || 0) + 1;
  categoryCounters.set(cat, count);
  
  const exLetter = letter;
  const exNumber = `Exhibit ${letter}-${count}`;
  
  if (doc.fileName) {
      assignedExhibitNumbers.set(doc.fileName, { letter: exLetter, number: exNumber });
  }

  return {
    ...doc,
    exhibitLetter: exLetter,
    exhibitNumber: exNumber
  };
});

console.log("mappedExhibits:", JSON.stringify(mappedExhibits, null, 2));

const fileName = "KCL_SoyoyeScholarship_2018.pdf";
const exhibitInfo = mappedExhibits.find(e => {
  if (!e.fileName) return false;
  const eName = e.fileName;
  const fName = fileName;
  const eBase = eName.split(/[/\\]/).pop() || eName;
  const fBase = fName.split(/[/\\]/).pop() || fName;
  return eName === fName || eName.includes(fName) || fName.includes(eName) || eBase === fBase;
});

console.log("exhibitInfo:", exhibitInfo);
