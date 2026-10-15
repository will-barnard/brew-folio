# samples/

Drop real Chase exports here to test the parsers. Everything in this folder
except this README is gitignored.

Useful set:
- a checking activity CSV (`Chase1234_Activity_YYYYMMDD.CSV`)
- a credit card activity CSV for each card
- one checking statement PDF and one card statement PDF covering the same
  period as the CSVs, so dedupe and reconciliation can be checked together

Run the parsers against them without touching a database:

    cd backend && node scripts/parse-sample.js ../samples/<file>
