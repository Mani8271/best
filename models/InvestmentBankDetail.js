const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db.js");

const InvestmentBankDetail = sequelize.define(
  "InvestmentBankDetail",
  {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    accountNumber: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    ifscCode: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    accountHolderName: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    bankName: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    branchName: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    bankPhoto: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    timestamps: true,
    indexes: [{ fields: ["userId"] }],
  }
);

module.exports = InvestmentBankDetail;
