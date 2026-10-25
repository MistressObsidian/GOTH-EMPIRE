export const plans = [
  { id: 'supporter', name: 'The Newcomer', price: 59.99, description: 'Your first step into Her private world.', benefits: ['Members-only content', 'Private booking requests', 'Session records', '5 private messages per calendar month'] },
  { id: 'inner-circle', name: 'The Loyal One', price: 119.99, description: 'Deeper devotion. Greater privileges.', popular: true, benefits: ['Expanded content library', 'Priority booking windows', 'Session requests and records', '15 private messages per calendar month'] },
  { id: 'elite', name: 'The Privileged', price: 199.99, description: 'The highest level of public access.', benefits: ['Full public-tier content library', 'First access to booking windows', 'Exclusive live event invitations', '30 private messages per calendar month'] }
];

export const tiers = [
  { id: 'observer', name: 'Payment pending / inactive', rank: 0, messages: 0 },
  ...plans.map((plan, index) => ({ ...plan, rank: index + 1, messages: [5, 15, 30][index] })),
  { id: 'chosen', name: 'The Chosen One', rank: 4, messages: 30 }
];
export const tierFor = id => tiers.find(tier => tier.id === id) || tiers[0];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const formatPrice = amount => usd.format(amount);
