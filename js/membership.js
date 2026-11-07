export const plans = [
  { id: 'supporter', name: 'The Newcomer', price: 59.99, description: 'Your first step into Her private world.', benefits: ['Members-only content', 'Private booking requests', 'Session records'] },
  { id: 'inner-circle', name: 'The Loyal One', price: 119.99, description: 'Deeper devotion. Greater privileges.', popular: true, benefits: ['Expanded content library', 'Priority booking windows', 'Session requests and records'] },
  { id: 'elite', name: 'The Privileged', price: 199.99, description: 'The highest level of public access.', benefits: ['Full public-tier content library', 'First access to booking windows', 'Exclusive live event invitations'] }
];

export const tiers = [
  { id: 'observer', name: 'No active membership', rank: 0, messages: null },
  ...plans.map((plan, index) => ({ ...plan, rank: index + 1, messages: null })),
  { id: 'chosen', name: 'The Chosen One', rank: 4, messages: null }
];
export const tierFor = id => tiers.find(tier => tier.id === id) || tiers[0];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const formatPrice = amount => usd.format(amount);
