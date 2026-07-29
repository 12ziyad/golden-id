const test = require('node:test'); const assert = require('node:assert/strict');
const { compareDocuments, extractDocumentText, validateRequiredDocuments } = require('../server');
test('accepts normalized matching fields',()=>assert.deepEqual(compareDocuments([{name:'Asha Devi',dob:'1990-01-01',gender:'F'},{name:' asha  devi ',dob:'1990-01-01',gender:'f'}]),[]));
test('reports mismatched name',()=>assert.equal(compareDocuments([{type:'pan',name:'Asha'},{type:'voter',name:'Usha'}])[0].field,'name'));
test('recovers common OCR mistakes in dates',()=>assert.equal(extractDocumentText({text:'Name\nASHA DEVI\nDate of Birth 2 I / O 5 / I 9 9 O\nABCDE1234F'}).dob,'21/05/1990'));
test('reads a value from the line after Name',()=>assert.equal(extractDocumentText({text:'INCOME TAX DEPARTMENT\nName\nASHA DEVI\nDate of Birth\n21/05/1990'}).name,'ASHA DEVI'));
test('rejects a value missing from one document',()=>assert.equal(compareDocuments([{type:'pan',name:'Asha',gender:''},{type:'voter',name:'Asha',gender:'F'}])[0].field,'gender'));
test('requires all five document types',()=>assert.match(validateRequiredDocuments([{type:'aadhaar'}]),/Birth Certificate/));
test('accepts one complete record for each mandatory type',()=>assert.equal(validateRequiredDocuments(['birth_certificate','aadhaar','pan','passport','voter'].map(type=>({type,name:'Asha',dob:'1990-01-01',number:'X1'}))),''));
