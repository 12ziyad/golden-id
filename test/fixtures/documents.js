'use strict';

// Sample OCR text and the expected extraction for each of the five document
// types. The PAN fixture deliberately carries a father's name, because the old
// extractor picked that up as the cardholder's name on every real PAN card.

const PAN_OCR = `INCOME TAX DEPARTMENT          GOVT. OF INDIA
Permanent Account Number Card
BQIPS8241E
Name
MUHAMMED SAKIR K
Father's Name
ABDUL RAHMAN K
Date of Birth
12/08/1997
Signature`;

const AADHAAR_OCR = `भारत सरकार
GOVERNMENT OF INDIA
मुहम्मद शाकिर के
MUHAMMED SAKIR K
जन्म तिथि / DOB: 12/08/1997
पुरुष / MALE
2341 2341 2346
आधार - आम आदमी का अधिकार
Address: 12 MG ROAD, BENGALURU, KARNATAKA - 560001`;

const PASSPORT_OCR = `REPUBLIC OF INDIA
PASSPORT
Type P  Country Code IND  Passport No. M1234567
Surname
K
Given Name(s)
MUHAMMED SAKIR
Date of Birth 12/08/1997   Sex M
Place of Birth BENGALURU
Date of Issue 05/01/2019   Date of Expiry 04/01/2029
P<INDK<<MUHAMMED<SAKIR<<<<<<<<<<<<<<<<<<<<<<
M1234567<0IND9708125M2901042<<<<<<<<<<<<<<08`;

const VOTER_OCR = `ELECTION COMMISSION OF INDIA
ELECTOR PHOTO IDENTITY CARD
ABC1234567
Elector's Name: MUHAMMAD SAKIR K
Father's Name: ABDUL RAHMAN K
Sex: M
Date of Birth: 12/08/1997
Address: 12 MG ROAD, BENGALURU 560001`;

const BIRTH_OCR = `MUNICIPAL CORPORATION OF BENGALURU
CERTIFICATE OF BIRTH
Registration No: BLR/1997/44821
Name: MUHAMMED SAKIR K
Sex: Male
Date of Birth: 12/08/1997
Father's Name: ABDUL RAHMAN K
Mother's Name: FATHIMA BEEVI
Place of Birth: BENGALURU`;

// What a well-behaved vision model should return for each fixture.
const MODEL_RESPONSES = {
  pan: {
    document_type: 'pan',
    name: 'MUHAMMED SAKIR K',
    father_name: 'ABDUL RAHMAN K',
    mother_name: null,
    spouse_name: null,
    dob: '12/08/1997',
    gender: null,
    address: null,
    document_number: 'BQIPS8241E',
    issue_date: null,
    expiry_date: null
  },
  aadhaar: {
    document_type: 'aadhaar',
    name: 'MUHAMMED SAKIR K',
    father_name: null,
    mother_name: null,
    spouse_name: null,
    dob: '12/08/1997',
    gender: 'MALE',
    address: '12 MG ROAD, BENGALURU, KARNATAKA - 560001',
    document_number: '2341 2341 2346',
    issue_date: null,
    expiry_date: null
  },
  passport: {
    document_type: 'passport',
    name: 'MUHAMMED SAKIR K',
    father_name: null,
    mother_name: null,
    spouse_name: null,
    dob: '12/08/1997',
    gender: 'M',
    address: null,
    document_number: 'M1234567',
    issue_date: '05/01/2019',
    expiry_date: '04/01/2029'
  },
  voter: {
    document_type: 'voter',
    name: 'MUHAMMAD SAKIR K',
    father_name: 'ABDUL RAHMAN K',
    mother_name: null,
    spouse_name: null,
    dob: '12/08/1997',
    gender: 'M',
    address: '12 MG ROAD, BENGALURU 560001',
    document_number: 'ABC1234567',
    issue_date: null,
    expiry_date: null
  },
  birth_certificate: {
    document_type: 'birth_certificate',
    name: 'MUHAMMED SAKIR K',
    father_name: 'ABDUL RAHMAN K',
    mother_name: 'FATHIMA BEEVI',
    spouse_name: null,
    dob: '12/08/1997',
    gender: 'Male',
    address: null,
    document_number: 'BLR/1997/44821',
    issue_date: null,
    expiry_date: null
  }
};

const OCR_TEXT = {
  pan: PAN_OCR,
  aadhaar: AADHAAR_OCR,
  passport: PASSPORT_OCR,
  voter: VOTER_OCR,
  birth_certificate: BIRTH_OCR
};

/** The five documents as the comparison layer expects to receive them. */
const comparableSet = () => Object.entries(MODEL_RESPONSES).map(([type, fields]) => ({
  type,
  fields,
  source: 'vision'
}));

module.exports = { OCR_TEXT, MODEL_RESPONSES, comparableSet };
